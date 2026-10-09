const assert = require('assert');
require('./helpers/isolatedSocialDatabase')('beginner-shot-restrictions');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Database = invoke('Database');
const Sell = invoke('GameServer/Items/NpcSellRules');
const Trade = invoke('GameServer/Bot/TradeService');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Backpack = invoke('GameServer/Actor/Backpack');
const character = name => ({ name, race: 0, classId: 0, maxHp: 100, maxMp: 100,
    sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83000, locY: 148000, locZ: -3400 });
(async () => {
    Database.init();
    await Database.createAccount('beginner_owner', 'pw');
    const owner = Number((await Database.createCharacter('beginner_owner', character('BeginnerOwner'))).insertId);
    const other = Number((await Database.createCharacter('beginner_owner', character('BeginnerOther'))).insertId);
    for (const selfId of [5789, 5790]) {
        const item = { fetchSelfId: () => selfId, fetchEquipped: () => false,
            fetchKind: () => 'Other.Soulshot', fetchAmount: () => 600 };
        assert.strictEqual(Sell.canSell(item), false);
        assert.strictEqual(Trade.isSellableInventoryItem(item), false);
        assert.strictEqual(Listing.classify({}, { selfId, count: 600 }).reason, 'beginner_shot');
        let removed = false;
        Backpack.prototype.dropItem.call({ fetchItemRaw: () => item, deleteItem: () => { removed = true; } }, {}, 1, 1, 0, 0, 0);
        assert.strictEqual(removed, false, 'drop must leave stock with its owner');
        await assert.rejects(Trade.buyFromStore({}, { storeType: 1, items: [{ selfId, count: 1, price: 1 }] }, selfId, 1), /cannot be traded/);
        const objectId = Number((await Database.setItem(owner, {
            selfId, name: 'Beginner shots', amount: 600, enchant: 0, equipped: false, slot: 0
        })).insertId);
        for (const storeType of [1, 3]) {
            await assert.rejects(Database.createAfkTradeShop(owner, { storeType, title: 'Blocked', town: 'Giran',
                locX: 83000, locY: 148000, locZ: -3400,
                lines: [{ objectId, selfId, name: 'Beginner shots', count: 1, price: 1, stackable: true }] }), /beginner_shot_not_tradable/);
        }
        await assert.rejects(Database.transferInventoryBetweenCharacters([
            { fromCharacterId: owner, toCharacterId: other, sourceItemId: objectId, selfId, amount: 1, stackable: true }
        ]), /invalid inventory transfer/);
        assert.strictEqual((await Database.fetchItems(owner)).find(row => Number(row.selfId) === selfId).amount, 600);
        assert.strictEqual((await Database.fetchItems(other)).length, 0);
    }
    assert.strictEqual(Sell.canSell({ fetchSelfId: () => 1835, fetchEquipped: () => false }), true,
        'ordinary shots remain sellable');
    console.log('PASS beginner NPC, board, store, trade and drop restrictions with unchanged inventory');
})().catch(error => { console.error(error); process.exitCode = 1; });
