const assert = require('assert');
require('../src/Global');

const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const Item = invoke('GameServer/Item/Item');

function item(id, amount) {
    return new Item(id, { selfId: 3001, name: 'Reserved Herb', kind: 'Other.Material', amount, stackable: true, equipped: false, slot: 0 });
}
function bag(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemRaw(id) { return this.items.find((entry) => entry.fetchId() === Number(id)); },
        fetchItemFromSelfId(selfId) { return this.items.find((entry) => entry.fetchSelfId() === Number(selfId)); },
        insertItem() {}
    };
}
const player = { accountId: 'player_reserve', dataSendToMe() {}, actor: { fetchId: () => 310, fetchName: () => 'ReserveLeader', fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false, backpack: bag([]) } };
const botItem = item(311, 5);
const bot = { accountId: 'bot_reserve', partyCompanion: true, followPlayerSession: player, actor: { fetchId: () => 311, fetchName: () => 'ReserveBot', fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false, backpack: bag([botItem]) } };

const opened = BotTradeService.startBotTrade(bot, player);
assert.strictEqual(opened.ok, true);
assert.strictEqual(BotTradeService.offerBotItem(bot, 311, 4).ok, true);
assert.strictEqual(BotTradeService.offerBotItem(bot, 311, 2).ok, true, 'updating the active offer uses an absolute desired quantity');
assert(BotTradeService.activeTradeSummary(bot).botItems.length === 1);
BotTradeService.cancel(bot, 'test_cancel', false);
assert.strictEqual(bot.botTradeReservations.size, 0, 'cancel must release reservations');

const reopened = BotTradeService.startBotTrade(bot, player);
assert.strictEqual(reopened.ok, true);
bot.botTradeReservations.set(311, { tradeId: 'other-trade', count: 5 });
assert.deepStrictEqual(BotTradeService.offerBotItem(bot, 311, 2), { ok: false, reason: 'insufficient_item' }, 'another trade reservation must be excluded from a new offer');
bot.botTradeReservations.delete(311);
assert.strictEqual(BotTradeService.offerBotItem(bot, 311, 5).ok, true, 'released reservation must be available to a new trade');
bot.activeTrade.expiresAt = Date.now() - 1;
assert.strictEqual(BotTradeService.activeTradeSummary(bot), null, 'expired trade must close');
assert.strictEqual(bot.botTradeReservations.size, 0, 'expiry must release reservations');
console.log('Bot trade reservation checks passed');
