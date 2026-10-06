'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-economy-events-'));
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE,
    `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Jobs = invoke('GameServer/Bot/Population/BackgroundJobRegistry');
const Cache = require('../src/GameServer/Bot/Population/LifeStateCache');
const { LifecycleEconomyEvents } = require('../src/GameServer/Bot/Population/LifecycleEconomyEvents');
const errors = [], disposers = [];
const flush = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve)); };
function registry(clock) {
    const queue = Jobs.create({ now: () => clock.now, setInterval: () => ({ unref() {} }), clearInterval() {},
        onError: (kind, error) => errors.push(error) });
    queue.start(clock.now); disposers.push(() => queue.stop()); return queue;
}
async function settled(driver) {
    for (let turn = 0; driver.running && turn < 500; turn++) await flush();
    assert.equal(driver.running, false, 'addressed native work completes');
}

async function main() {
    Data.init(); Database.init(); await Life.init(); await Afk.init();
    await Database.createAccount('bot_event_economy', 'fixture');
    const id = Number((await Database.createCharacter('bot_event_economy', { name: 'EconomyEvents', classId: 0,
        race: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 0, locY: 0, locZ: 0 })).insertId);
    await Database.execute(['INSERT INTO warehouse_items(selfId,name,amount,characterId) VALUES (1869,\'Iron Ore\',10,?)', [id]]);
    await Database.setCharacterRecipe(id, 20, 'dwarven');
    const state = await Life.upsertState({ characterId: id, name: 'EconomyEvents', accountName: 'bot_event_economy',
        phase: 'cold', activity: 'hunting', level: 1, loc: { locX: 0, locY: 0, locZ: 0 }, inventory: {}, adena: 0,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {}, stats: { classId: 0 } }, 'event_fixture');
    Population.started = true;
    const previousProfile = Population.playerActivityProfile;
    Population.playerActivityProfile = () => ({ protected: false, realPlayers: 0 });
    disposers.push(() => { Population.stopLifecycleEconomyEvents(); Population.started = false;
        Population.playerActivityProfile = previousProfile; Population.backgroundJobRegistry = null; });
    const nativeClock = { now: Date.now() }, nativeQueue = registry(nativeClock);
    Population.backgroundJobRegistry = nativeQueue; Population.startLifecycleEconomyEvents();
    const nativeDriver = Population.lifecycleEconomyEvents;
    await flush(); nativeQueue.tick(nativeClock.now); await settled(nativeDriver);
    assert.equal(errors.length, 0);
    assert(nativeDriver.records.get(id).items.has(1869), 'native stored rows enter the addressed item index');
    assert(nativeDriver.records.get(id).items.has(1463), 'a known recipe output is watched without bag stock');
    assert(nativeDriver.records.get(id).items.has(1458), 'known recipe material IDs use their canonical selfId');
    assert.equal((await Database.execute(['SELECT characterId FROM bot_goal_state WHERE characterId=?', [id]])).length, 1,
        'production consumer reaches the real goal writer through native owner admission');
    const current = Life.cachedState(id);
    for (const activity of ['resting', 'dead', 'shopping', 'traveling', 'party_wait']) {
        assert.equal(Population.lifecycleEconomyInput({ ...current, activity }).eligible, false);
    }
    const GoalState = invoke('GameServer/Bot/Goals/GoalState');
    await GoalState.set(id, { type: 'hunt', nextReviewAt: nativeClock.now + 5000 });
    assert.equal(Population.lifecycleEconomyInput({ ...current,
        stats: { ...current.stats, marketSellRetryAfter: nativeClock.now + 2000 } }, nativeClock.now).dueAt,
    nativeClock.now + 2000, 'independent real deadlines use the earliest future edge');
    // Actual supply notifications stay in the Worker's funded buyer index.
    // Neither a normal SELL nor a restored board may turn this seller index
    // into another unbounded buyer dispatcher.
    nativeDriver.dirty.clear();
    await Database.createAccount('event_human_seller', 'fixture');
    const sellerId = Number((await Database.createCharacter('event_human_seller', { name: 'EventSeller', classId: 0,
        race: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 0, locY: 0, locZ: 0 })).insertId);
    const stock = await Database.setItem(sellerId, { selfId: 1463, name: 'Soulshot: D-grade', amount: 10 });
    const sale = await Database.createAfkTradeShop(sellerId, { kind: 'sell_ad', storeType: Afk.SELL, town: 'Giran',
        lines: [{ objectId: Number(stock.insertId), selfId: 1463, name: 'Soulshot: D-grade', count: 10, price: 10, stackable: true }] });
    assert(sale.shop); Afk.refreshRecord(sale.shop);
    assert.equal(nativeDriver.boardPending.size, 0);
    assert.equal(nativeDriver.dirty.size, 0);
    await Afk.init();
    nativeQueue.tick(nativeClock.now); await settled(nativeDriver);
    assert.equal(nativeDriver.boardPending.size, 0); assert.equal(nativeDriver.dirty.size, 0);
    assert.equal(nativeDriver.metrics.runs, 1, 'SELL-only restoration does not wake another buyer through demand recovery');
    Population.stopLifecycleEconomyEvents();
    console.log('PASS native source/writer, stock/recipe watches, activity/deadline fences and SELL-only buyer isolation');

    // Real cache publication and the common deadline heap; the decision is
    // controlled to isolate event delivery from economic price policy.
    const cache = new Cache(), clock = { now: 1000 }, queue = registry(clock);
    const sources = Array.from({ length: 140 }, (_, index) => ({ characterId: index + 1, phase: 'cold',
        activity: 'hunting', level: 1, inventory: {}, stats: { itemId: 1869, value: 1 } }));
    sources.forEach(row => cache.set(row.characterId, row));
    const pages = [], calls = [], repairs = [];
    const life = { cachedState: key => cache.get(key), subscribePublications: (...args) => cache.subscribePublications(...args),
        async safetyPage({ afterId = 0, highWaterId = 140, limit }) {
            assert.equal(limit, 64);
            const ids = sources.map(row => row.characterId).filter(key => key > afterId && key <= highWaterId).slice(0, limit);
            pages.push(ids.length);
            return { rows: ids.map(characterId => ({ characterId })), cursor: { afterId: ids.at(-1) || highWaterId, highWaterId },
                done: !ids.length || ids.at(-1) === highWaterId };
        } };
    let boardListener, quote = 'old', deferred = false, nextGoal = 0;
    const driver = new LifecycleEconomyEvents({ registry: queue, life, now: () => clock.now,
        board: { subscribeBoardChanges(listener) { boardListener = listener; return () => { boardListener = null; }; } },
        boardKey: () => quote,
        input: row => ({ key: String(row.stats.value), eligible: row.activity === 'hunting', items: [row.stats.itemId],
            dueAt: row.characterId === 1 ? nextGoal : 0 }),
        work(row) { calls.push(row); if (row.characterId === 1 && !nextGoal) nextGoal = clock.now + 100;
            return { deferred }; }, onRepair: () => repairs.push(1), onError: error => errors.push(error) });
    disposers.push(() => driver.stop()); driver.start(); await flush();
    assert.equal(driver.records.size, 140);
    queue.tick(clock.now); await flush();
    assert.equal(driver.records.get(1).dueAt, clock.now + 100, 'a goal-only write rearms its next deadline');
    for (const record of driver.records.values()) record.handled = true;
    driver.dirty.clear(); nextGoal = 0;
    cache.set(1, { ...cache.get(1), loc: { locX: 10, locY: 0, locZ: 0 } });
    assert.equal(driver.dirty.size, 0, 'movement alone refreshes reference without an economic decision');
    boardListener({ selfIds: [1869], ready: true }); assert.equal(driver.boardPending.size, 0);
    quote = 'new'; boardListener({ selfIds: [1869], ready: true });
    const inspected = driver.metrics.boardInspected;
    queue.tick(clock.now); await flush();
    assert.equal(driver.metrics.boardInspected - inspected, 64, 'one pulse never walks every affected owner');
    for (let turn = 0; turn < 145 && (driver.boardPending.size || driver.dirty.size); turn++) {
        queue.tick(clock.now); await flush();
    }
    assert.equal(new Set(calls.slice(1).map(row => row.characterId)).size, 140, 'finite continuation reaches sellers beyond five');
    const callCount = calls.length;
    for (let turn = 0; turn < 3; turn++) { queue.tick(clock.now); await flush(); }
    assert.equal(calls.length, callCount, 'unchanged ticks do not run population reviews');
    quote = 'unfinished'; boardListener({ selfIds: [1869], ready: true });
    queue.tick(clock.now); await flush();
    const beforeReset = driver.metrics.boardInspected;
    const callsBeforeReset = calls.length;
    boardListener({ reset: true, ready: false });
    queue.tick(clock.now); await flush();
    assert.equal(driver.metrics.boardInspected, beforeReset, 'restoring a board pauses unfinished item delivery');
    assert.equal(calls.length, callsBeforeReset, 'queued economic work also waits for the restored board');
    boardListener({ ready: true });
    for (let turn = 0; turn < 145 && (driver.boardPending.size || driver.dirty.size); turn++) {
        queue.tick(clock.now); await flush();
    }
    assert.equal(new Set(calls.slice(callCount).map(row => row.characterId)).size, 140,
        'restoration with an unchanged quote retains all previously accepted owner obligations');
    console.log('PASS metadata coalescing, original current references, bounded delivery and no seller starvation');

    for (const record of driver.records.values()) record.handled = true;
    driver.dirty.clear();
    cache.set(2, { ...cache.get(2), activity: 'resting' });
    quote = 'while_busy'; boardListener({ selfIds: [1869] });
    for (let turn = 0; turn < 3; turn++) { queue.tick(clock.now); await flush(); }
    assert.equal(driver.dirty.has(2), false);
    driver.dirty.clear();
    cache.set(2, { ...cache.get(2), activity: 'hunting' });
    assert(driver.dirty.has(2), 'a pending edge survives rest and wakes on return');
    driver.dirty.clear(); deferred = true;
    cache.set(3, { ...cache.get(3), stats: { itemId: 1869, value: 2 } });
    queue.tick(clock.now); await flush();
    assert(queue.deadlineTokens.has(driver.records.get(3)), 'busy work has a real retry deadline');
    deferred = false; clock.now += 1000; queue.tick(clock.now); await flush();
    assert(calls.some(row => row === cache.get(3)));
    console.log('PASS pending busy-owner edges and common-heap retry');

    driver.dirty.clear();
    boardListener({ reset: true, ready: false }); quote = 'restored'; boardListener({ ready: true });
    for (let turn = 0; turn < 3; turn++) { queue.tick(clock.now); await flush(); }
    assert(driver.metrics.boardInspected >= inspected + 280, 'ready without item IDs recovers the finite indexed cut');
    driver.dirty.clear();
    for (const record of driver.records.values()) record.handled = true;
    const publish = cache.publish;
    cache.publish = () => {};
    cache.set(140, { ...cache.get(140), stats: { itemId: 1869, value: 99 } });
    cache.publish = publish;
    clock.now += 30 * 60000;
    for (let turn = 0; turn < 8; turn++) { queue.tick(clock.now); await flush(); }
    assert(pages.length >= 3 && pages.every(size => size <= 64));
    assert.equal(repairs.length, 1, 'only a recovered lost input increments the repair counter');
    assert(calls.some(row => row === cache.get(140)));
    console.log('PASS board-ready recovery and paged 30-minute lost-event repair');

    driver.stop(); const stoppedCalls = calls.length;
    queue.tick(clock.now + 60000); await flush();
    assert.equal(calls.length, stoppedCalls); assert.equal(queue.deadlineTokens.size, 0);
    assert.equal(errors.length, 0);
    console.log('PASS stop cancels all service deadlines and subscriptions');
    assert(state.characterId > 0);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    disposers.reverse().forEach(dispose => dispose()); Afk.stop();
    await Database.close(); fs.rmSync(directory, { recursive: true, force: true });
    console.log('cleanup=true');
});
