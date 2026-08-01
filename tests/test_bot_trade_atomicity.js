const assert = require('assert');
require('../src/Global');

const Database = invoke('Database');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const Item = invoke('GameServer/Item/Item');

function item(id, selfId, amount, name) {
    return new Item(id, { selfId, name, kind: 'Other.Material', amount, stackable: true, equipped: false, slot: 0 });
}
function bag(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemRaw(id) { return this.items.find((entry) => entry.fetchId() === Number(id)); },
        fetchItemFromSelfId(selfId) { return this.items.find((entry) => entry.fetchSelfId() === Number(selfId)); },
        insertItem(id, selfId, data) { this.items.push(new Item(id, { selfId, ...data, kind: 'Other.Material', stackable: true })); }
    };
}
const playerItem = item(401, 4001, 2, 'Player Token');
const botItem = item(402, 4002, 3, 'Bot Token');
const player = { accountId: 'player_atomic', dataSendToMe() {}, actor: { fetchId: () => 410, fetchName: () => 'AtomicLeader', fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false, backpack: bag([playerItem]) } };
const bot = { accountId: 'bot_atomic', partyCompanion: true, followPlayerSession: player, actor: { fetchId: () => 411, fetchName: () => 'AtomicBot', fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false, backpack: bag([botItem]) } };

const originalTransfer = Database.transferInventoryBetweenCharacters;
Database.transferInventoryBetweenCharacters = async () => { throw new Error('forced db failure'); };

(async () => {
    try {
        assert.strictEqual(BotTradeService.startBotTrade(bot, player).ok, true);
        assert.strictEqual(BotTradeService.offerBotItem(bot, 402, 1).ok, true);
        assert.strictEqual(BotTradeService.addItem(player, 401, 1).ok, true);
        const failed = await BotTradeService.commit(player);
        assert.strictEqual(failed.ok, false, 'DB failure must reject the commit');
        assert.strictEqual(failed.reason, 'database_failed', 'DB failure must expose a stable reason');
        assert.strictEqual(playerItem.fetchAmount(), 2);
        assert.strictEqual(botItem.fetchAmount(), 3);
        assert(player.activeTrade, 'failed commit should leave a cancellable trade');
        console.log('Bot trade atomicity checks passed');
    } finally {
        Database.transferInventoryBetweenCharacters = originalTransfer;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
