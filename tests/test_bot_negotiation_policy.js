const assert = require('assert');
require('../src/Global');

const BotNegotiationService = invoke('GameServer/Bot/Economy/BotNegotiationService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Item = invoke('GameServer/Item/Item');


function actor(id, name, backpack) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        backpack
    };
}

function backpack(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemRaw(id) { return this.items.find((item) => Number(item.fetchId()) === Number(id)); }
    };
}

const player = { accountId: 'player_neg_policy', actor: actor(910, 'NegotiationPlayer', backpack([])) };
const item = new Item(911, {
    selfId: 9011,
    name: 'Policy Herb',
    kind: 'Other.Material',
    price: 1000,
    amount: 4,
    stackable: true,
    equipped: false,
    slot: 0
});
const bot = {
    accountId: 'bot_neg_policy',
    plan: 'following',
    persona: {
        primaryDrive: 'wealth',
        traits: { caution: 0.8, ambition: 0.7, assertiveness: 0.7 }
    },
    actor: actor(912, 'PolicyMerchant', backpack([item]))
};

const originalSnapshot = BotSocialMemory.getSnapshot;
try {
    BotSocialMemory.getSnapshot = (_player, session) => session.accountId === 'bot_neg_policy' && _player.accountId === 'player_neg_policy'
        ? { trust: 0, familiarity: 0 }
        : { trust: 0, familiarity: 0 };

    const stranger = BotNegotiationService.quoteItem(bot, player, 911, 1);
    assert.strictEqual(stranger.ok, true);
    assert.strictEqual(stranger.negotiation.relation, 'stranger');
    assert(stranger.negotiation.minimumUnitPrice <= stranger.negotiation.currentUnitPrice);
    assert(stranger.negotiation.currentUnitPrice <= stranger.negotiation.maximumUnitPrice);
    assert.match(stranger.negotiation.rationale, /value|reference|margin/i);
    const firstRange = [stranger.negotiation.minimumUnitPrice, stranger.negotiation.maximumUnitPrice];
    BotNegotiationService.declinePrice(bot, player);

    BotSocialMemory.getSnapshot = () => ({ trust: 9, familiarity: 9 });
    const trusted = BotNegotiationService.quoteItem(bot, player, 911, 1);
    assert.strictEqual(trusted.ok, true);
    assert.strictEqual(trusted.negotiation.relation, 'trusted');
    assert(trusted.negotiation.currentUnitPrice < stranger.negotiation.currentUnitPrice, 'trusted relationship should receive a deterministic discount');
    assert(trusted.negotiation.minimumUnitPrice <= firstRange[0]);
    assert(trusted.negotiation.maximumUnitPrice <= firstRange[1], 'relationship remains within the same deterministic market ceiling');
    assert.strictEqual(BotNegotiationService.counterOffer(bot, player, trusted.negotiation.minimumUnitPrice - 1).reason, 'price_out_of_bounds');
    assert.strictEqual(bot.botNegotiationReservations.get(911).count, 1);
    BotNegotiationService.declinePrice(bot, player);
    assert.strictEqual(bot.botNegotiationReservations.size, 0, 'decline releases stock reservation');
    const lifecycle = BotNegotiationService.quoteItem(bot, player, 911, 1);
    assert.strictEqual(lifecycle.ok, true);
    assert.strictEqual(BotNegotiationService.cleanup(bot, 'death'), true);
    assert.strictEqual(BotNegotiationService.activeSummary(player), null, 'death cleanup clears both negotiation participants');
    assert.strictEqual(bot.botNegotiationReservations.size, 0, 'death cleanup releases reserved stock');
    // Relationship labels and the quote each label gets.
    const labels = [
        [null, 'stranger'], [{ trust: 0, familiarity: 0 }, 'stranger'], [{ trust: 0, familiarity: 1 }, 'familiar'],
        [{ trust: 2, familiarity: 4 }, 'familiar'], [{ trust: 3, familiarity: 0 }, 'friendly'],
        [{ trust: 0, familiarity: 5 }, 'friendly'], [{ trust: 7, familiarity: 9 }, 'friendly'],
        [{ trust: 8, familiarity: 0 }, 'trusted'], [{ trust: -4, familiarity: 0 }, 'stranger'],
        [{ trust: -5, familiarity: 0 }, 'wary'], [{ trust: -5, familiarity: 6 }, 'friendly'], [{ trust: -9, familiarity: 3 }, 'wary']
    ];
    for (const [memory, label] of labels) {
        assert.strictEqual(BotSocialMemory.relationship(memory), label, `relationship of ${JSON.stringify(memory)}`);
    }
    const quotes = labels.filter(([memory]) => memory).map(([memory]) => {
        BotSocialMemory.getSnapshot = () => memory;
        const quote = BotNegotiationService.quoteItem(bot, player, 911, 1).negotiation;
        BotNegotiationService.declinePrice(bot, player);
        return [quote.relation, quote.minimumUnitPrice, quote.currentUnitPrice, quote.maximumUnitPrice];
    });
    assert.deepStrictEqual(quotes, [
        ['stranger', 784, 1088, 1306], ['familiar', 780, 1078, 1306], ['familiar', 780, 1078, 1306],
        ['friendly', 770, 1048, 1306], ['friendly', 770, 1048, 1306], ['friendly', 770, 1048, 1306],
        ['trusted', 756, 1008, 1306], ['stranger', 784, 1088, 1306], ['wary', 805, 1148, 1366],
        ['friendly', 770, 1048, 1306], ['wary', 805, 1148, 1366]
    ], 'each relationship keeps its price');
    console.log('Bot negotiation policy checks passed');
} finally {
    BotSocialMemory.getSnapshot = originalSnapshot;
    BotNegotiationService.reset();
}
