const assert = require('assert');
require('../src/Global');

const Database = invoke('Database');
const BotNegotiationService = invoke('GameServer/Bot/Economy/BotNegotiationService');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Item = invoke('GameServer/Item/Item');

options.default.OpenRouter.negotiationEnabled = true;

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
        fetchItemRaw(id) { return this.items.find((item) => Number(item.fetchId()) === Number(id)); },
        fetchItemFromSelfId(selfId) { return this.items.find((item) => Number(item.fetchSelfId()) === Number(selfId)); },
        insertItem(id, selfId, data) {
            this.items.push(new Item(id, { selfId, ...data, kind: Number(selfId) === 57 ? 'Other.Currency' : 'Other.Material', stackable: true }));
        }
    };
}

const playerItem = new Item(921, { selfId: 57, name: 'Adena', kind: 'Other.Currency', amount: 5000, stackable: true, equipped: false, slot: 0 });
const botItem = new Item(922, { selfId: 9022, name: 'Negotiated Ore', kind: 'Other.Material', price: 1000, amount: 2, stackable: true, equipped: false, slot: 0 });
const playerBackpack = backpack([playerItem]);
const botBackpack = backpack([botItem]);
const packets = [];
const player = { accountId: 'player_neg_flow', dataSendToMe: (packet) => packets.push(packet), actor: actor(920, 'FlowPlayer', playerBackpack) };
const bot = { accountId: 'bot_neg_flow', plan: 'merchant', actor: actor(921, 'FlowMerchant', botBackpack) };
const originalSnapshot = BotSocialMemory.getSnapshot;
const originalTransfer = Database.transferInventoryBetweenCharacters;

(async () => {
try {
    BotSocialMemory.getSnapshot = () => ({ trust: 3, familiarity: 5 });
    Database.transferInventoryBetweenCharacters = async (entries) => entries.map((entry, index) => ({
        ...entry,
        targetItemId: 9300 + index,
        remaining: entry.sourceItemId === 922 ? 1 : Number(entry.sourceItemId === 921 ? 5000 - entry.amount : 0)
    }));

    const quoted = BotNegotiationService.quoteItem(bot, player, 922, 1);
    assert.strictEqual(quoted.ok, true);
    assert(quoted.negotiation.currentTotalPrice > 0);
    const countered = BotNegotiationService.counterOffer(bot, player, quoted.negotiation.minimumUnitPrice);
    assert.strictEqual(countered.ok, true);
    const total = countered.negotiation.currentTotalPrice;
    const accepted = BotNegotiationService.acceptPrice(bot, player, total);
    assert.strictEqual(accepted.ok, true);
    const opened = BotNegotiationService.openNegotiatedTrade(bot, player);
    assert.strictEqual(opened.ok, true);
    assert.deepStrictEqual(packets.slice(0, 2).map((packet) => packet[0]), [0x1e, 0x21]);
    assert.strictEqual(BotTradeService.addItem(player, 921, total).ok, true, 'player must add the exact accepted Adena price');
    const committed = await BotTradeService.commit(player);
    assert.strictEqual(committed.ok, true);
    assert.strictEqual(committed.negotiationId, accepted.negotiation.id);
    assert.strictEqual(BotNegotiationService.activeSummary(bot), null, 'completed negotiation must be cleared');
    assert.strictEqual(playerItem.fetchAmount(), 5000 - total);
    assert.strictEqual(botItem.fetchAmount(), 1);
    assert(playerBackpack.fetchItemFromSelfId(9022), 'native commit must deliver exactly the negotiated item');
    assert.strictEqual(botBackpack.fetchItemFromSelfId(57).fetchAmount(), total, 'native commit must deliver exact payment');
    assert.strictEqual(JSON.stringify(await BotTradeService.commit(player)).includes('idempotent'), true, 'replay remains safe');

    const stale = BotNegotiationService.quoteItem(bot, player, 922, 1);
    assert.strictEqual(stale.ok, true);
    botItem.setAmount(0);
    assert.strictEqual(BotNegotiationService.activeSummary(bot), null, 'stock changes expire the quote');
    assert.strictEqual(bot.botNegotiationReservations.size, 0);
    assert.strictEqual(BotNegotiationService.activeSummary(bot), null, 'summary cannot revive an expired quote');

    botItem.setAmount(1);
    const rounds = BotNegotiationService.quoteItem(bot, player, 922, 1);
    assert.strictEqual(rounds.ok, true);
    assert.strictEqual(BotNegotiationService.counterOffer(bot, player, rounds.negotiation.minimumUnitPrice).ok, true);
    assert.strictEqual(BotNegotiationService.counterOffer(bot, player, rounds.negotiation.maximumUnitPrice).ok, true);
    assert.strictEqual(BotNegotiationService.counterOffer(bot, player, rounds.negotiation.currentTotalPrice).ok, true);
    assert.strictEqual(BotNegotiationService.counterOffer(bot, player, rounds.negotiation.currentTotalPrice).reason, 'round_limit');
    BotNegotiationService.declinePrice(bot, player);

    const ttl = BotNegotiationService.quoteItem(bot, player, 922, 1);
    assert.strictEqual(ttl.ok, true);
    bot.activeNegotiation.expiresAt = Date.now() - 1;
    assert.strictEqual(BotNegotiationService.activeSummary(bot), null, 'TTL expires an unanswered quote');
    assert.strictEqual(bot.botNegotiationReservations.size, 0);
    const previousId = ttl.negotiation.id;
    BotNegotiationService.reset();
    const afterReset = BotNegotiationService.quoteItem(bot, player, 922, 1);
    assert.strictEqual(afterReset.ok, true);
    assert.notStrictEqual(afterReset.negotiation.id, previousId, 'negotiation IDs must remain unique across service resets');
    console.log('Bot negotiation flow checks passed');
} finally {
    BotSocialMemory.getSnapshot = originalSnapshot;
    Database.transferInventoryBetweenCharacters = originalTransfer;
    BotNegotiationService.reset();
}
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
