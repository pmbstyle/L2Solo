const assert = require('assert');
require('../src/Global');

const Database = invoke('Database');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const Item = invoke('GameServer/Item/Item');

function makeItem(id, selfId, amount, name = `Material ${selfId}`, enchant = 0) {
    return new Item(id, {
        selfId,
        name,
        kind: 'Other.Material',
        amount,
        stackable: true,
        equipped: false,
        slot: 0,
        enchant
    });
}

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
        backpack: bag
    };
}

const playerPackets = [];
const playerItem = makeItem(101, 1001, 2, 'Player Ore');
const botItem = makeItem(201, 2001, 6, 'Bot Herb', 5);
const playerBackpack = backpack([playerItem]);
const botBackpack = backpack([botItem]);
const player = { accountId: 'player_trade', dataSendToMe: (packet) => playerPackets.push(packet), actor: actor(100, 'TradeLeader', playerBackpack) };
const bot = { accountId: 'bot_trade', partyCompanion: true, followPlayerSession: player, actor: actor(200, 'TradeCompanion', botBackpack) };

const originalTransfer = Database.transferInventoryBetweenCharacters;
Database.transferInventoryBetweenCharacters = async (entries) => entries.map((entry, index) => ({
    ...entry,
    targetItemId: 900 + index,
    remaining: entry.selfId === 2001 ? 3 : 0
}));

(async () => {
try {
    const opened = BotTradeService.startBotTrade(bot, player);
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(playerPackets[0][0], 0x1e, 'outbound bot trade must use native TradeStart');
    const offered = BotTradeService.offerBotItem(bot, 201, 3);
    assert.strictEqual(offered.ok, true);
    assert.strictEqual(playerPackets[1][0], 0x21, 'bot offer must use native TradeOtherAdd');
    assert.strictEqual(playerPackets[1].readUInt16LE(25), 5, 'bot trade line must expose the offered item enchant level');
    assert.strictEqual(botItem.fetchAmount(), 6, 'reservation must not mutate inventory before confirmation');

    const committed = await BotTradeService.commit(player);
    assert.strictEqual(committed.ok, true);
    assert.strictEqual(committed.direction, 'bot_outbound');
    assert.strictEqual(botItem.fetchAmount(), 3, 'confirmed trade must deduct the bot resource');
    assert.strictEqual(playerBackpack.fetchItemFromSelfId(2001).fetchAmount(), 3, 'confirmed trade must add the resource to player inventory');
    assert.strictEqual(playerBackpack.fetchItemFromSelfId(2001).fetchEnchantLevel(), 5, 'confirmed trade must preserve enchant in live recipient inventory');
    const replay = await BotTradeService.commit(player);
    assert.strictEqual(replay.idempotent, true, 'double confirmation must be idempotent');
    assert.doesNotThrow(() => JSON.stringify(replay), 'idempotent replay must not retain live session cycles');
    console.log('Bot outbound trade checks passed');
} finally {
    Database.transferInventoryBetweenCharacters = originalTransfer;
}
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
