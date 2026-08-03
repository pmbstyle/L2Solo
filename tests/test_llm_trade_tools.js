const assert = require('assert');
require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const Item = invoke('GameServer/Item/Item');

function actor(id, name, backpack) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        state: { fetchSeated: () => false, setSeated() {} },
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
            this.items.push(new Item(id, { selfId, ...data, kind: 'Other.Material', stackable: true }));
        }
    };
}

const playerBackpack = backpack([]);
const botBackpack = backpack([new Item(612, {
    selfId: 6012,
    name: 'Trade Herb',
    kind: 'Other.Material',
    amount: 3,
    stackable: true,
    equipped: false,
    slot: 0
})]);
const packets = [];
const player = {
    accountId: 'player_trade_tools',
    dataSendToMe(packet) { packets.push(packet); },
    actor: actor(610, 'TradeLeader', playerBackpack)
};
const bot = {
    accountId: 'bot_trade_tools',
    plan: 'following',
    partyCompanion: true,
    followPlayerSession: player,
    actor: actor(611, 'TradeCompanion', botBackpack)
};

function decision(action, turnId, extra = {}) {
    return { action, confidence: 0.99, reason: 'trade tool test', turnId, ...extra };
}

function context(turnId, session = player) {
    return { playerSession: session, conversationTurn: { turnId } };
}

try {
    const proposed = BotAgentTools.execute(bot, decision('propose_trade', 'trade-tool-1'), [], context('trade-tool-1'));
    assert.strictEqual(proposed.applied, true);
    assert.strictEqual(proposed.reason, 'trade_proposed');
    assert.strictEqual(packets[0][0], 0x1e, 'propose_trade must open the native trade window');

    const offered = BotAgentTools.execute(bot, decision('offer_resources', 'trade-tool-2', { tradeItemId: 6012, tradeAmount: 2 }), [], context('trade-tool-2'));
    assert.strictEqual(offered.applied, true);
    assert.strictEqual(offered.line.count, 2);
    assert.strictEqual(offered.line.objectId, 612, 'template self id input must resolve to the canonical inventory object id');
    assert.strictEqual(packets[1][0], 0x21, 'offer_resources must use native TradeOtherAdd');

    const stranger = { accountId: 'player_stranger', actor: actor(699, 'Stranger', backpack([])) };
    const unauthorized = BotAgentTools.execute(bot, decision('cancel_trade', 'trade-tool-3'), [], context('trade-tool-3', stranger));
    assert.deepStrictEqual(unauthorized, { applied: false, reason: 'not_authorized' });
    assert(bot.activeTrade, 'unauthorized leader must not cancel the open trade');

    const cancelled = BotAgentTools.execute(bot, decision('cancel_trade', 'trade-tool-4'), [], context('trade-tool-4'));
    assert.deepStrictEqual(cancelled, { applied: true, reason: 'trade_cancelled' });
    assert.strictEqual(bot.activeTrade, null);

    const atomic = BotAgentTools.execute(bot, decision('give_resources', 'trade-tool-5', {
        tradeItemId: 6012,
        tradeAmount: 1
    }), [], context('trade-tool-5'));
    assert.strictEqual(atomic.applied, true);
    assert.strictEqual(atomic.outcome, 'pending', 'resource delivery must remain pending until native player confirmation');
    assert.strictEqual(atomic.line.count, 1);
    assert.strictEqual(packets[3][0], 0x1e, 'give_resources must open native trade');
    assert.strictEqual(packets[4][0], 0x21, 'give_resources must display the native resource line atomically');
    console.log('LLM trade tool checks passed');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
