const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const Item = invoke('GameServer/Item/Item');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const BotManager = invoke('GameServer/Bot/BotManager');
const tradeRequest = invoke('GameServer/Network/Request/TradeRequest');
const addTradeItem = invoke('GameServer/Network/Request/AddTradeItem');
const tradeDone = invoke('GameServer/Network/Request/TradeDone');

function item(id, selfId, amount, name) {
    return new Item(id, {
        selfId,
        name,
        kind: 'Other.Material',
        amount,
        stackable: true,
        equipped: false,
        slot: 0
    });
}

function backpack(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemRaw(id) { return this.items.find((entry) => Number(entry.fetchId()) === Number(id)); },
        fetchItemFromSelfId(selfId) { return this.items.find((entry) => Number(entry.fetchSelfId()) === Number(selfId)); },
        insertItem(id, selfId, data) {
            this.items.push(item(id, selfId, data.amount, data.name));
        }
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
const playerItem = item(101, 1001, 2, 'Player Token');
const player = {
    accountId: 'player_native_trade',
    dataSendToMe: (packet) => playerPackets.push(packet),
    actor: actor(100, 'NativeTrader', backpack([playerItem]))
};
const bot = {
    accountId: 'bot_native_trade',
    partyCompanion: true,
    followPlayerSession: player,
    actor: actor(200, 'TradeCompanion', backpack([]))
};

const original = {
    transfer: Database.transferInventoryBetweenCharacters,
    recordEvent: BotSocialMemory.recordEvent,
    resolveTrade: BotLootEtiquette.resolveTrade,
    applyBestUpgrades: BotEquipmentUpgrade.applyBestUpgrades,
    recordJournal: BotEventJournal.record,
    botTell: BotManager.botTell,
    findSessionById: BotManager.findSessionById
};
const botTellCalls = [];

(async () => {
    try {
        Database.transferInventoryBetweenCharacters = async (entries) => entries.map((entry) => ({
            ...entry,
            targetItemId: 201,
            remaining: entry.fromCharacterId === 100 ? 1 : 0
        }));
        BotSocialMemory.recordEvent = () => Promise.resolve();
        BotLootEtiquette.resolveTrade = () => null;
        BotEquipmentUpgrade.applyBestUpgrades = () => [];
        BotEventJournal.record = () => Promise.resolve();
        BotManager.botTell = (source, target, text) => botTellCalls.push({ source, target, text });
        BotManager.findSessionById = (id) => Number(id) === 200 ? bot : null;

        const requestPacket = Buffer.from([0x15, 200, 0, 0, 0]);
        tradeRequest(player, requestPacket);
        const openedTrade = player.activeTrade;
        assert(openedTrade, 'TradeRequest must attach an active trade');
        assert.strictEqual(openedTrade.botConfirmed, true, 'the virtual bot must confirm its side server-side');
        assert(playerPackets.some((packet) => packet[0] === 0x1e), 'TradeRequest must open the native trade window');

        addTradeItem(player, Buffer.from([0x16, 0, 0, 0, 0, 101, 0, 0, 0, 1, 0, 0, 0]));
        assert(playerPackets.some((packet) => packet[0] === 0x20), 'AddTradeItem must echo the own trade line');

        tradeRequest(player, requestPacket);
        assert.strictEqual(player.activeTrade, openedTrade, 'repeated native trade requests must not discard the open trade');
        assert.strictEqual(player.activeTrade.playerItems.get(101).count, 1);

        await tradeDone(player, Buffer.from([0x17, 1, 0, 0, 0]));

        assert.strictEqual(playerItem.fetchAmount(), 1, 'confirmed trade must deduct the player item');
        assert.strictEqual(player.actor.backpack.fetchItemFromSelfId(1001).fetchAmount(), 1);
        assert(playerPackets.some((packet) => packet[0] === 0x22 && packet[1] === 1), 'client must receive successful TradeDone');

        bot.actor.backpack.items = Array.from({ length: 81 }, (_, index) => item(1000 + index, 2000 + index, 1, `Full Slot ${index + 1}`));
        const capacityTrade = tradeRequest(player, requestPacket);
        assert.strictEqual(capacityTrade, undefined, 'TradeRequest handler should keep its packet-handler contract');
        addTradeItem(player, Buffer.from([0x16, 0, 0, 0, 0, 101, 0, 0, 0, 1, 0, 0, 0]));
        const tellsBeforeCapacityFailure = botTellCalls.length;
        await tradeDone(player, Buffer.from([0x17, 1, 0, 0, 0]));
        assert.strictEqual(botTellCalls.length, tellsBeforeCapacityFailure + 1, 'capacity failure should notify the player in chat');
        assert.strictEqual(botTellCalls.at(-1).target, player, 'capacity notice should target the trading player');
        assert(botTellCalls.at(-1).text.includes('inventory is full'), 'capacity notice should explain the inventory blocker');
        console.log('Bot player trade packet checks passed');
    } finally {
        Database.transferInventoryBetweenCharacters = original.transfer;
        BotSocialMemory.recordEvent = original.recordEvent;
        BotLootEtiquette.resolveTrade = original.resolveTrade;
        BotEquipmentUpgrade.applyBestUpgrades = original.applyBestUpgrades;
        BotEventJournal.record = original.recordJournal;
        BotManager.botTell = original.botTell;
        BotManager.findSessionById = original.findSessionById;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
