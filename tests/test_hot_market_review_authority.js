const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
require(path.join(root, 'src/Global'));
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World');
const ActorModel = invoke('GameServer/Model/Actor');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hot-market-authority-'));
options.default.Database.path = path.join(directory, 'world.sqlite');
options.default.Database.historyPath = path.join(directory, 'history.sqlite');
let releaseFlush;
let releaseLocation;
let transition;
let review;
const originalLocation = Database.updateCharacterLocation;
const clone = value => JSON.parse(JSON.stringify(value));
async function run() {
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    await Database.createAccount('bot_hot_durable_control', 'pw');
    const id = Number((await Database.createCharacter('bot_hot_durable_control', {
        name: 'HotDurableControl', race: 0, classId: 0, sex: 0, face: 0, hair: 0, hairColor: 0,
        maxHp: 100, maxMp: 100, locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, equipped: false, enchant: 0, slot: 0 });
    await Database.setItem(id, { selfId: 1864, name: 'Stem', amount: 20, equipped: false, enchant: 0, slot: 0 });
    const rows = await Database.fetchItems(id);
    const now = Date.now();
    assert(await LifeState.upsertState({ characterId: id, accountName: 'bot_hot_durable_control', name: 'HotDurableControl',
        phase: 'hot', activity: 'hunting', level: 40, exp: 0, sp: 0, adena: 1000,
        inventory: LifeState.inventorySummaryFromItems(rows), currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: now, nextResolveAt: null }, stats: { generatedCold: true, classId: 0 } }, 'hot_durable_seed'));
    const source = rows.find(row => Number(row.selfId) === 1864);
    const pricing = { price: 100, seenCounter: 0, seenItem: 0, rival: 90, worth: 0, seenFills: 0 };
    const shop = (await Database.createAfkTradeShop(id, { kind: 'sell_ad', storeType: AfkTrade.SELL, town: 'Giran',
        lines: [{ objectId: source.id, selfId: 1864, name: 'Stem', count: 5, price: 100, stackable: true, pricing }] })).shop;
    AfkTrade.refreshRecord(shop);
    const actor = new ActorModel({ id, isOnline: true, locX: 83000, locY: 148000, locZ: -3400 });
    const session = { actor, accountId: 'bot_hot_durable_control', fetchAccountId() { return this.accountId; } };
    actor.session = session;
    World.insertUser(session);
    const expected = clone(LifeState.cachedState(id).simulation);
    const cacheOnly = () => {
        const row = LifeState.cachedState(id);
        return session.actor === actor && actor.fetchIsOnline() && row.phase === 'hot'
            && JSON.stringify(row.simulation) === JSON.stringify(expected);
    };
    assert(cacheOnly(), 'prototype actual cache/current actor hot guard initially accepts');

    const hotAuthority = { ownerId: expected.ownerId, revision: Number(expected.revision || 0),
        leaseId: expected.leaseId || null };
    const proposal = (cursor) => {
        const current = AfkTrade.ownerRecords(id).find(record => Number(record.id) === Number(shop.id));
        const line = current.lines[0];
        return { reprices: [], withdrawals: [], updates: [{ recordId: current.id, lineId: line.id,
            expectedRevision: current.revision, previousPricing: clone(line.pricing),
            pricing: { ...clone(line.pricing), seenCounter: cursor, seenItem: cursor } }] };
    };
    assert.deepStrictEqual(await BotMarket.applyReview(id, proposal(1), { hotAuthority, canCommitReview: cacheOnly }),
        { changed: 0, updated: 1 }, 'same native hot authority accepts a metadata-only observation');
    for (const wrong of [{ ...hotAuthority, ownerId: 'foreign-owner' },
        { ...hotAuthority, revision: hotAuthority.revision + 1 }, { ...hotAuthority, leaseId: 'foreign-lease' }]) {
        await assert.rejects(BotMarket.applyReview(id, proposal(2), { hotAuthority: wrong, canCommitReview: cacheOnly }),
            /stale_market_review/, 'a mismatched durable hot tuple refuses before writing');
    }
    const before = (await Database.execute(['SELECT * FROM afk_trade_lines WHERE shopId = ?', [shop.id]]));

    let flushEntered;
    const flushReady = new Promise(resolve => { flushEntered = resolve; });
    const flushGate = new Promise(resolve => { releaseFlush = resolve; });
    let held = false;
    Database.registerCharacterWriteFlush(characterId => {
        if (Number(characterId) !== id || held) return WriteQueue.flushCharacter(characterId);
        held = true;
        flushEntered();
        return flushGate.then(() => WriteQueue.flushCharacter(characterId));
    });
    const line = AfkTrade.ownerRecords(id).find(record => Number(record.id) === Number(shop.id)).lines[0];
    review = BotMarket.applyReview(id, { reprices: [], withdrawals: [], updates: [{
        recordId: shop.id, lineId: line.id, expectedRevision: shop.revision, previousPricing: clone(line.pricing),
        pricing: { ...clone(line.pricing), seenCounter: 2, seenItem: 2 } }] }, { hotAuthority, canCommitReview: cacheOnly });
    await flushReady;
    let locationEntered;
    const locationReady = new Promise(resolve => { locationEntered = resolve; });
    const locationGate = new Promise(resolve => { releaseLocation = resolve; });
    Database.updateCharacterLocation = function(characterId, loc) {
        return originalLocation.call(this, characterId, loc).then(result => {
            if (Number(characterId) !== id) return result;
            locationEntered();
            return locationGate.then(() => result);
        });
    };
    // Same actual producer as Cooldown.transitionToColdState: native phase save
    // completes before the subsequent awaited location/experience/vitals/cache.
    transition = LifeState.upsertState({ ...LifeState.snapshot(id), phase: 'cold' }, 'hot_durable_handoff', { releaseHot: true });
    await locationReady;
    const durable = (await Database.execute(['SELECT phase, simulationOwner, simulationRevision, simulationLeaseId FROM bot_life_state WHERE characterId = ?', [id]]))[0];
    assert.equal(durable.phase, 'cold');
    assert.equal(LifeState.cachedState(id).phase, 'hot', 'real producer cache publication remains behind awaited location');
    assert(cacheOnly(), 'cache-only prototype guard still permits the retired durable authority');
    releaseFlush();
    await assert.rejects(review, /stale_market_review/,
        'durable hot handoff refuses despite a cache-only runtime guard still permitting');
    const after = await Database.execute(['SELECT * FROM afk_trade_lines WHERE shopId = ?', [shop.id]]);
    assert.deepStrictEqual(after, before, 'rejected hot review preserves quote, metadata, fills and escrowed stock');
    console.log('Hot native market authority: valid control, exact tuple and durable-before-cache handoff PASS');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    releaseFlush?.();
    releaseLocation?.();
    Database.updateCharacterLocation = originalLocation;
    Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
    await transition;
    if (review) await review.catch(() => {});
    await WriteQueue.flushAll();
    AfkTrade._resetForTests();
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
