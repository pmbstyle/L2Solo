// Requirement of the board (step 3.3, E14, E22): a cold bot never buys
// remotely from a live private store. A player's or a bot's live store
// trades face to face; a cold buyer sees only board records, NPC shops and
// the configured city merchants.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const PrivateStore = invoke('GameServer/PrivateStore');

const databasePath = path.join(process.cwd(), 'tmp', 'test-board-no-remote-private-store.sqlite');
const STEM = 1864;

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

async function character(account, name) {
    await Database.createAccount(account, 'pw');
    return Number((await Database.createCharacter(account, {
        name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 82700, locY: 148600, locZ: -3470
    })).insertId);
}

async function amount(characterId, selfId) {
    const [row] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM items WHERE characterId = ? AND selfId = ?',
        [characterId, selfId]]);
    return Number(row.amount);
}

// A live store as PrivateStore.publishSell leaves it on the actor (no town).
function liveSession(account, id, name, stemRowId) {
    const model = {
        privateStoreType: 1,
        privateStore: { kind: 'player', ownerId: id, storeType: 1, title: 'WTS',
            items: [{ objectId: stemRowId, selfId: STEM, count: 3, price: 50 }] }
    };
    const actor = {
        fetchId: () => id,
        fetchName: () => name,
        fetchPrivateStore: () => model.privateStore,
        setPrivateStore: (value) => { model.privateStore = value; },
        fetchPrivateStoreType: () => model.privateStoreType,
        setPrivateStoreType: (value) => { model.privateStoreType = value; },
        state: { setSeated: () => {} }
    };
    return { accountId: account, actor, model };
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();

    const playerId = await character('player_shop', 'PlayerShop');
    const playerStem = Number((await Database.setItem(playerId, { selfId: STEM, name: 'Stem', amount: 5, enchant: 0, equipped: false, slot: 0 })).insertId);
    const hotBotId = await character('bot_hot_shop', 'HotBotShop');
    const hotBotStem = Number((await Database.setItem(hotBotId, { selfId: STEM, name: 'Stem', amount: 5, enchant: 0, equipped: false, slot: 0 })).insertId);
    const player = liveSession('player_shop', playerId, 'PlayerShop', playerStem);
    const hotBot = liveSession('bot_hot_shop', hotBotId, 'HotBotShop', hotBotStem);
    World.user.sessions.push(player, hotBot);

    const buyerId = await character('bot_cold_buyer', 'ColdBuyer');
    await Database.setItem(buyerId, { selfId: 57, name: 'Adena', amount: 1000, enchant: 0, equipped: false, slot: 0 });
    const buyer = await LifeState.upsertState({
        characterId: buyerId, accountName: 'bot_cold_buyer', name: 'ColdBuyer', level: 40, adena: 1000,
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', loc: { locX: 82700, locY: 148600, locZ: -3470 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(buyerId)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { generatedCold: true }, timing: {}
    }, 'test_seed');

    // E14: the live stores are not offered to a cold buyer, in any town.
    for (const town of ['Giran', 'Aden', null]) {
        const offers = MarketOpportunity.findOffers(STEM, { town, buyerCharacterId: buyerId });
        assert(!offers.some((offer) => offer.sourceType === 'private_store' && offer.sellerKind !== 'fixed'),
            `E14: a cold buyer in ${town || 'any town'} sees no live player or bot store`);
    }
    const goal = { type: 'buy_craft_material', status: 'active', target: { itemId: STEM, itemName: 'Stem' } };
    const result = await ColdMarketService.tryPurchase(buyer, goal);
    assert.notStrictEqual(result.offer?.sourceType, 'private_store', 'E14: the cold buyer does not buy from a live store');
    assert.strictEqual(await amount(playerId, STEM), 5, 'E14: the player keeps every stem');
    assert.strictEqual(await amount(hotBotId, STEM), 5, 'E14: the hot bot keeps every stem');
    assert.strictEqual(player.model.privateStore.items[0].count, 3, 'E14: the player\'s store line is untouched');
    assert.strictEqual(await amount(buyerId, STEM), 0, 'E14: no stem appears from a live store');

    // E22: a store closed with quit keeps its object on the actor; it is not
    // offered either.
    PrivateStore.quit?.(player);
    assert(!MarketOpportunity.findOffers(STEM, { town: 'Aden', buyerCharacterId: buyerId })
        .some((offer) => Number(offer.sourceId) === playerId), 'E22: a quit store is never offered');

    await Database.close();
    clean();
    console.log('Board: cold bots never buy remotely from a live private store (E14, E22)');
})().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
});
