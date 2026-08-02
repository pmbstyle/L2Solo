const assert = require('assert');
require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotNegotiationService = invoke('GameServer/Bot/Economy/BotNegotiationService');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const Item = invoke('GameServer/Item/Item');

options.default.OpenRouter.negotiationEnabled = true;

function backpack(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemRaw(id) { return this.items.find((item) => Number(item.fetchId()) === Number(id)); },
        fetchItemFromSelfId(selfId) { return this.items.find((item) => Number(item.fetchSelfId()) === Number(selfId)); },
        insertItem(id, selfId, data) { this.items.push(new Item(id, { selfId, ...data, kind: 'Other.Material', stackable: true })); }
    };
}

function actor(id, name, bag) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        state: { fetchSeated: () => false, setSeated() {} },
        backpack: bag
    };
}

const player = {
    accountId: 'player_llm_neg',
    actor: actor(940, 'NegotiationLeader', backpack([
        new Item(943, { selfId: 57, name: 'Adena', kind: 'Other.Currency', amount: 5000, stackable: true, equipped: false, slot: 0 })
    ]))
};
const botItem = new Item(941, { selfId: 9041, name: 'Quoted Cloth', kind: 'Other.Material', price: 1000, amount: 2, stackable: true, equipped: false, slot: 0 });
const bot = { accountId: 'bot_llm_neg', plan: 'merchant', actor: actor(942, 'NegotiationMerchant', backpack([botItem])) };

function decision(action, turnId, extra = {}) {
    return { action, confidence: 0.99, reason: 'negotiation tool test', turnId, ...extra };
}

function context(turnId, session = player) {
    return { playerSession: session, conversationTurn: { turnId } };
}

try {
    assert(BotAgentTools.toolDescriptions(bot).some((tool) => tool.action === 'quote_item'));
    const quoted = BotAgentTools.execute(bot, decision('quote_item', 'neg-tool-1', { negotiationItemId: 941, negotiationAmount: 1 }), [], context('neg-tool-1'));
    assert.strictEqual(quoted.applied, true);
    assert.strictEqual(quoted.reason, 'price_quoted');

    const stranger = { accountId: 'player_llm_stranger', actor: actor(949, 'Stranger', backpack([])) };
    const rejected = BotAgentTools.execute(bot, decision('decline_price', 'neg-tool-2'), [], context('neg-tool-2', stranger));
    assert.deepStrictEqual(rejected, { applied: false, reason: 'not_authorized' });

    const counter = BotAgentTools.execute(bot, decision('counter_offer', 'neg-tool-3', { negotiationPrice: quoted.negotiation.currentTotalPrice }), [], context('neg-tool-3'));
    assert.strictEqual(counter.applied, true);
    const accepted = BotAgentTools.execute(bot, decision('accept_price', 'neg-tool-4', { negotiationPrice: counter.negotiation.currentTotalPrice }), [], context('neg-tool-4'));
    assert.strictEqual(accepted.applied, true);
    const opened = BotAgentTools.execute(bot, decision('open_negotiated_trade', 'neg-tool-5'), [], context('neg-tool-5'));
    assert.strictEqual(opened.applied, true);
    assert.strictEqual(opened.trade.negotiationId, accepted.negotiation.id);
    BotTradeService.cancel(bot, 'test_cleanup', false);
    assert.strictEqual(BotNegotiationService.activeSummary(bot), null);
    console.log('LLM negotiation tool checks passed');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    BotNegotiationService.reset();
}
