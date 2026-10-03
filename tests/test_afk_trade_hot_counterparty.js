const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-afk-trade-hot-counterparty.sqlite');

function character(name) {
    return { name, race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 83000, locY: 148000, locZ: -3400 };
}

function amount(rows, selfId) {
    return rows.filter((row) => Number(row.selfId) === Number(selfId))
        .reduce((sum, row) => sum + Number(row.amount), 0);
}

function clean() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();

    await Database.createAccount('bot_hot_wtb_owner', 'pw');
    await Database.createAccount('bot_hot_seller', 'pw');
    const ownerId = Number((await Database.createCharacter('bot_hot_wtb_owner', character('WtbOwner'))).insertId);
    const sellerId = Number((await Database.createCharacter('bot_hot_seller', character('HotSeller'))).insertId);
    await Database.setItem(ownerId, { selfId: 57, name: 'Adena', amount: 100000, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(sellerId, { selfId: 57, name: 'Adena', amount: 1000, enchant: 0, equipped: false, slot: 0 });
    const varnishId = Number((await Database.setItem(sellerId, {
        selfId: 1865, name: 'Varnish', amount: 2, enchant: 0, equipped: false, slot: 0
    })).insertId);

    const vitals = { hp: 100, maxHp: 100, mp: 100, maxMp: 100 };
    await LifeState.upsertState({
        characterId: ownerId, accountName: 'bot_hot_wtb_owner', name: 'WtbOwner',
        phase: 'cold', activity: 'hunting', level: 40, exp: 0, adena: 100000,
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, currentRegion: 'Giran',
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(ownerId)),
        vitals, stats: { generatedCold: true }, timing: {}
    }, 'test_wtb_owner');
    await AfkTrade.publishBot(ownerId, {
        storeType: AfkTrade.BUY, title: 'WTB Varnish', town: 'Giran',
        locX: 81100, locY: 148000, locZ: -3466,
        appearance: { model: character('WtbOwner') },
        lines: [{ selfId: 1865, name: 'Varnish', count: 1, price: 500, stackable: true }]
    });

    // The activation snapshot the hot session keeps (session.coldLifeState):
    // phase cold, the background spot, the experience at activation.
    const backgroundLoc = { locX: -84700, locY: 244200, locZ: -3730 };
    const activation = await LifeState.upsertState({
        characterId: sellerId, accountName: 'bot_hot_seller', name: 'HotSeller',
        phase: 'cold', activity: 'hunting', level: 40, exp: 18604656, sp: 0, adena: 1000,
        loc: backgroundLoc, currentRegion: 'Giran',
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(sellerId)),
        vitals, stats: { generatedCold: true }, timing: {}
    }, 'test_activation');
    // markHot: the durable lifecycle becomes hot, then the actor plays in the
    // world and its own saves move the character on.
    await LifeState.upsertState({ ...activation, phase: 'hot' }, 'spawn');
    const hotLoc = { locX: 81200, locY: 148100, locZ: -3466 };
    await Database.updateCharacterExperience(sellerId, 40, 18728112, 0);
    await Database.updateCharacterLocation(sellerId, hotLoc);

    const store = AfkTrade.findOwnerProjection(ownerId).actor.fetchPrivateStore();
    const trade = await AfkTrade.sellToShop(sellerId, store, 1865, 1,
        { objectId: varnishId, expectedPrice: 500, coldState: activation });

    const items = await Database.fetchItems(sellerId);
    assert.strictEqual(amount(items, 1865), 1, 'the sale itself commits');
    assert.strictEqual(amount(items, 57), 1500);
    assert.strictEqual(LifeState.snapshot(sellerId).phase, 'hot',
        'an AFK trade must not turn the hot row cold while the actor is in the world');
    assert.strictEqual(trade.coldState, null, 'no cold snapshot is returned for a hot character');
    const row = (await Database.fetchCharacters('bot_hot_seller'))[0];
    assert.strictEqual(Number(row.exp), 18728112, 'experience earned while hot must not roll back');
    assert.deepStrictEqual({ locX: Number(row.locX), locY: Number(row.locY), locZ: Number(row.locZ) }, hotLoc,
        'the live location must not roll back to the background spot');

    const owner = LifeState.snapshot(ownerId);
    assert.strictEqual(owner.phase, 'cold');
    assert.strictEqual(Number(owner.inventory['1865']?.amount), 1, 'a cold WTB owner is still synced');

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('AFK trade hot counterparty tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
