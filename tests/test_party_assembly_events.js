'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'party-assembly-events-'));
const previousConfig = process.env.L2NODE_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const Cache = require('../src/GameServer/Bot/Population/LifeStateCache');
const Jobs = invoke('GameServer/Bot/Population/BackgroundJobRegistry');
const { PartyAssemblyEvents, SAFETY_INTERVAL_MS } = require('../src/GameServer/Bot/Population/PartyAssemblyEvents');
const errors = [], disposers = [];
const flush = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve)); };
let sequence = 0;
async function seed(stats = {}) {
    const username = `bot_assembly_${++sequence}`;
    await DB.createAccount(username, 'fixture');
    const id = Number((await DB.createCharacter(username, { name: `Assembly${sequence}`, classId: 0,
        race: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 0, locY: 0, locZ: 0 })).insertId);
    await DB.execute(['UPDATE characters SET level=10,hp=100,mp=100 WHERE id=?', [id]]);
    return Life.upsertState({ characterId: id, name: `Assembly${sequence}`, accountName: username,
        phase: 'cold', activity: 'party_wait', level: 10, spotId: 'event-fixture',
        loc: { locX: 0, locY: 0, locZ: 0 }, inventory: {}, adena: 0,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {}, stats: { classId: 0, ...stats } }, 'assembly_fixture');
}
function registry(clock) {
    const result = Jobs.create({ now: () => clock.now, setInterval: () => ({ unref() {} }), clearInterval() {},
        onError: (kind, error) => errors.push(error) });
    result.start(clock.now); disposers.push(() => result.stop()); return result;
}
async function main() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init(); await Parties.init();
    if (!process.argv.includes('--events-only')) {
    const packets = [];
    const unsubscribe = Life.subscribePublications(packet => packets.push(packet), { replay: true });
    const request = { status: 'open', priority: 'required', reason: 'shared_target', requestedAt: Date.now(),
        spotId: 'event-fixture', objectiveKey: 'event-fixture:1869', itemId: 1869, npcId: 20003 };
    const a = await seed({ partyRequest: request }), b = await seed({ partyRequest: request });
    await flush();
    assert(packets.some(packet => packet.state === a));
    assert(packets.some(packet => packet.state === b));
    const refreshed = await Life.upsertState({ ...a, loc: { locX: 1, locY: 0, locZ: 0 } }, 'assembly_move');
    assert(packets.some(packet => packet.state === refreshed && packet.previousState === a));
    unsubscribe();
    console.log('PASS actual Life publication/replay carries current original state and previous reference');

    // The production consumer invokes the unchanged native membership commit.
    // Only foreground/lag pressure is supplied: no server/Worker is started.
    const savedProfile = Population.playerActivityProfile;
    Population.playerActivityProfile = () => ({ protected: false, realPlayers: 0 });
    Population.started = true;
    const originalMin = Config.partyMinSize, originalMax = Config.partyMaxSize;
    Config.partyMinSize = 2; Config.partyMaxSize = 2;
    const clock = { now: Date.now() }, jobs = registry(clock);
    const driver = new PartyAssemblyEvents({ registry: jobs, life: Life, parties: Parties,
        classify: state => Population.partyAssemblyInput(state),
        run: (rows, timestamp, help) => Population.runPartyAssemblyEvent(rows, timestamp, help),
        expire: id => Population.refreshPartyAssemblyRequest(id), onError: error => errors.push(error) });
    disposers.push(() => driver.stop()); driver.start(); await flush();
    jobs.tick(clock.now); await flush();
    for (let turns = 0; driver.running && turns < 500; turns++) await flush();
    const joinedA = Life.cachedState(a.characterId), joinedB = Life.cachedState(b.characterId);
    assert(joinedA.party.partyId, 'event-driven native formation creates a real party');
    assert.equal(joinedA.party.partyId, joinedB.party.partyId);
    const [nativeParty] = await DB.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', [joinedA.party.partyId]]);
    assert.deepEqual(JSON.parse(nativeParty.memberIdsJson).sort((x, y) => x - y), [a.characterId, b.characterId]);
    driver.stop(); Population.started = false; Population.playerActivityProfile = savedProfile;
    Config.partyMinSize = originalMin; Config.partyMaxSize = originalMax;
    console.log('PASS addressed publication group performs real native membership commit without formation timers');
    }

    // Member reads follow declared ids in the newest cache, with no query or publication.
    const cacheParties = [];
    for (let index = 0; index < 5; index++) {
        const partyId = `cache-party-${index}`, members = [await seed(), await seed()];
        for (const member of members) await Life.upsertState({ ...member, level: 11,
            activity: 'grouped', party: { partyId, leaderId: members[0].characterId } }, 'cache_party_fixture');
        cacheParties.push({ partyId, leaderId: members[0].characterId, memberIds: members.map(member => member.characterId),
            status: 'active', spotId: 'event-fixture', stats: {} });
    }
    const freshId = cacheParties[0].memberIds[0];
    await DB.execute(['UPDATE bot_life_state SET level=1 WHERE characterId=?', [freshId]]);
    const originalExecute = DB.execute, originalActive = Parties.active;
    let memberQueries = 0, publications = 0;
    const unpublish = Life.subscribePublications(() => publications++);
    DB.execute = function(statement) { if (/SELECT[\s\S]*bot_life_state/i.test(statement[0])) memberQueries++; return originalExecute.apply(this, arguments); };
    Parties.active = () => cacheParties;
    try {
        const readStarted = performance.now();
        for (let read = 0; read < 1000; read++) Life.cachedStatesForParties(cacheParties);
        const memberReadMs = (performance.now() - readStarted) / 10000;
        assert(memberReadMs <= 0.05, `cached member read ${memberReadMs}ms`);
        console.log(`CACHE_READ_MS_PER_MEMBER ${memberReadMs.toFixed(6)}`);
        const grouped = Life.cachedStatesForParties(cacheParties);
        assert.equal(grouped.size, 5); assert.equal(grouped.get('cache-party-0')[0].level, 11);
        await Population.recruitBackgroundMembers([]);
        assert.equal(memberQueries, 0, 'five-party recruitment reads no member DB rows');
        assert.equal(publications, 0, 'member reads publish nothing');
        assert.equal(Life.cachedState(freshId).level, 11, 'a stale DB row cannot overwrite the newer cache');
        Population.partyRequirementRefreshDue.clear();
        await Population.reviewBackgroundPartyDemand([]);
        assert.equal(Population.partyRequirementRefreshDue.size, 0, 'no required waiters marks no refresh');
        await Population.reviewBackgroundPartyDemand([{ characterId: 999 }]);
        assert.equal(Population.partyRequirementRefreshDue.size, Config.partyRequirementRefreshBatchSize);
    } finally { DB.execute = originalExecute; Parties.active = originalActive; unpublish(); Population.partyRequirementRefreshDue?.clear(); }
    console.log('PASS five-party cache reads, no publications, cache authority and addressed refresh marks');

    const stampCache = new Cache(), stampTick = { now: Date.now() }, stampRegistry = registry(stampTick);
    let stampPartyListener;
    const stampLife = { cachedState: id => stampCache.get(id), subscribePublications: (...args) => stampCache.subscribePublications(...args) };
    const stampService = new PartyAssemblyEvents({ registry: stampRegistry, life: stampLife,
        parties: { subscribeChanges(fn) { stampPartyListener = fn; return () => {}; } },
        classify: state => Population.partyAssemblyInput(state, stampTick.now), run: () => {}, now: () => stampTick.now });
    for (const [id, spotId] of [[4001, 'A'], [4002, 'B']]) stampCache.set(id, { characterId: id, phase: 'cold',
        level: 30, activity: 'hunting', spotId, inventory: {}, adena: 0, stats: { classId: 0 } });
    stampService.start(); disposers.push(() => stampService.stop()); await flush(); stampService.dirty.clear();
    const startEvents = stampService.metrics.events;
    for (let loot = 0; loot < 100; loot++) {
        const before = stampCache.get(4001);
        stampCache.set(4001, { ...before, adena: before.adena + 900, inventory: { 1869: { amount: loot + 1 } } });
    }
    await flush();
    assert.equal(stampService.metrics.events, startEvents); assert.equal(stampService.dirty.size, 0, '100 loots enqueue nothing');
    const beforeRequest = stampCache.get(4001);
    stampCache.set(4001, { ...beforeRequest, stats: { ...beforeRequest.stats,
        partyRequest: { status: 'open', priority: 'required', spotId: 'A', requestedAt: stampTick.now } } });
    await flush();
    assert.equal(stampService.metrics.events, startEvents + 1); assert.deepEqual([...stampService.dirty], ['spot:A']);
    assert.equal(stampService.records.get(4001).stamp.length, 8);
    stampService.dirty.clear();
    stampPartyListener({ partyId: 'dissolved-A', status: 'dissolved', spotId: 'A', memberIds: [] },
        { status: 'active', spotId: 'A', memberIds: [] });
    assert.deepEqual([...stampService.dirty], ['spot:A'], 'dissolve wakes only its hunting spot');
    stampService.stop(); console.log('PASS eight-field stamp, 100 loot publications, request edge and one-spot dissolve');

    // Actual cache and common registry, controlled decision callback. Safety
    // uses pages of retained rows; no population iterator/planner is needed.
    const cache = new Cache(), tick = { now: 1000 }, queue = registry(tick);
    const sources = Array.from({ length: 200 }, (_, index) => ({ characterId: index + 1, phase: 'cold',
        activity: 'hunting', level: 10, updatedAt: 1, loc: { locX: index, locY: 0, locZ: 0 },
        stats: { request: index < 2 ? 'pair' : `solo${index}` }, timing: {} }));
    sources.forEach(row => cache.set(row.characterId, row));
    const pages = [], attempts = [], expired = [], repairs = [];
    const life = { cachedState: id => cache.get(id), subscribePublications: (...args) => cache.subscribePublications(...args),
        async safetyPage({ afterId = 0, highWaterId = 200, limit }) {
            assert.equal(limit, 64); const ids = sources.map(row => row.characterId).filter(id => id > afterId && id <= highWaterId).slice(0, limit);
            pages.push(ids.length);
            return { rows: ids.map(characterId => ({ characterId })), cursor: { afterId: ids.at(-1) || highWaterId, highWaterId }, done: !ids.length || ids.at(-1) === highWaterId };
        } };
    let partyListener, defer = false;
    const service = new PartyAssemblyEvents({ registry: queue, life, parties: { subscribeChanges(fn) { partyListener = fn; return () => { partyListener = null; }; } },
        now: () => tick.now, retryMs: 100,
        classify: state => state.party?.partyId ? null : ({ key: state.stats.request, stamp: [state.level, null, null, state.stats.request, state.stats.status || null, null, null, null], dueAt: state.deadline || 0 }),
        run(rows, timestamp, help) { attempts.push({ rows, help }); return { deferred: defer }; },
        expire(id) { expired.push(id); const current = cache.get(id); cache.set(id, { ...current, deadline: 0 }); },
        onRepair: () => repairs.push(1), onError: error => errors.push(error) });
    disposers.push(() => service.stop()); service.start(); await flush();
    const replayed = service.records.size; assert.equal(replayed, 200);
    queue.tick(tick.now); await flush();
    assert.equal(attempts.length, 1); assert.deepEqual(attempts[0].rows, sources.slice(0, 2));
    const calls = attempts.length;
    cache.set(1, { ...cache.get(1), loc: { locX: 900, locY: 0, locZ: 0 }, updatedAt: 2 });
    assert(!service.dirty.has('pair'), 'coordinate publication refreshes reference without re-running same decision');
    tick.now += 10; queue.tick(tick.now); await flush();
    assert.equal(attempts.length, calls + 1, 'one other dirty group runs per pulse');
    // Remove the other startup group edges to isolate address/retry controls.
    for (const group of service.groups.values()) { group.handled = group.revision; }
    service.dirty.clear();
    const previous = cache.get(1); const changed = { ...previous, level: 11, stats: { ...previous.stats, status: 'open' } };
    defer = true; cache.set(1, changed); queue.tick(tick.now); await flush();
    assert(attempts.at(-1).rows.includes(changed), 'changed current source is in the addressed group');
    assert(service.deadlines.has(service.groups.get('pair')));
    const pending = attempts.length;
    tick.now += 99; queue.tick(tick.now); await flush(); assert.equal(attempts.length, pending);
    defer = false; tick.now++; queue.tick(tick.now); await flush(); assert.equal(attempts.length, pending + 1);
    assert.equal(repairs.length, 0, 'normal busy/retry is not a missed event');
    service.observe({ characterId: 1, state: previous }); assert.equal(service.records.get(1).state, changed);
    partyListener({ partyId: 'real-membership-event', memberIds: [1], status: 'active' }, { memberIds: [], status: 'active' });
    service.wakeHelp(); queue.tick(tick.now); await flush(); assert.equal(attempts.at(-1).help, true);
    console.log('PASS bounded event/coalescing/current-ref, real retry deadline, membership/help and unchanged pulse controls');

    cache.set(2, { ...cache.get(2), deadline: tick.now + 50 });
    tick.now += 50; queue.tick(tick.now); await flush(); assert.deepEqual(expired, [2]);
    queue.tick(tick.now); await flush(); assert.deepEqual(expired, [2]);
    console.log('PASS request deadline fires once through shared heap');

    // Simulate one lost accepted publication, plus one lost queued edge.
    for (const group of service.groups.values()) group.handled = group.revision;
    service.dirty.clear(); service.cancel(service.groups.get('pair'));
    const removed = service.records.get(3); service.groups.get(removed.key).members.delete(3); service.records.delete(3);
    const pair = service.groups.get('pair'); pair.revision++; service.dirty.delete(pair.key);
    tick.now = 1000 + SAFETY_INTERVAL_MS - 1; queue.tick(tick.now); await flush(); assert.equal(pages.length, 0);
    tick.now++; queue.tick(tick.now); await flush();
    assert.equal(pages.length, 1); assert.equal(pages[0], 64); assert.equal(repairs.length, 2);
    for (let pulse = 0; service.cycle && pulse < 20; pulse++) { queue.tick(++tick.now); await flush(); }
    assert.equal(service.cycle, null); assert(pages.every(count => count <= 64));
    assert.equal(repairs.length, 2);
    tick.now += SAFETY_INTERVAL_MS; queue.tick(tick.now); await flush();
    for (let pulse = 0; service.cycle && pulse < 20; pulse++) { queue.tick(++tick.now); await flush(); }
    assert.equal(repairs.length, 2, 'repeated healthy safety passes do not recount repaired edges');
    const oldAttempts = attempts.length; service.stop(); queue.tick(tick.now + SAFETY_INTERVAL_MS); await flush();
    assert.equal(attempts.length, oldAttempts); assert.equal(service.records.size, 0); assert.equal(service.deadlines.size, 0);
    cache.clear();
    console.log('PASS first 30min page/cursor, lost-edge repair exactly once, healthy pass and stop fencing');

    const own = await seed({ classId: 56, playedHours: 2, production: { revenue: 200, profit: 40, crafts: 3, customers: 2 } });
    const better = await seed({ classId: 56, playedHours: 2, production: { revenue: 400, crafts: 5, customers: 4 } });
    const unknown = await seed({ classId: 56, playedHours: 0, production: { revenue: 99999 } });
    const outsider = await seed({ classId: 56, playedHours: 1, production: { revenue: 1000000 } });
    const status = Workshop.producerStatus(own, [better.characterId, unknown.characterId]);
    assert.equal(status.incomePerHour, 120); assert.equal(status.rank, 2); assert.equal(status.knownCount, 3);
    assert.equal(status.nextIncomePerHour, 200); assert.equal(status.crafts, 3); assert.equal(status.customers, 2);
    assert.equal(Workshop.producerStatus(unknown, []).incomePerHour, null);
    assert(!status.inputKey.includes(`${outsider.characterId}:`));
    const updated = await Life.upsertState({ ...better, stats: { ...better.stats, production: { revenue: 600 } } }, 'producer_status_update');
    assert(Workshop.producerStatus(own, [updated.characterId]).inputKey !== Workshop.producerStatus(own, []).inputKey);
    assert.equal(Workshop.producerStatus(own, [updated.characterId]).nextIncomePerHour, 300);
    assert.equal(errors.length, 0, errors.map(error => error?.stack || String(error)).join('\n'));
    console.log('PASS current known producer income/rank, unknown time, unrelated producer exclusion and status input invalidation');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const dispose of disposers.reverse()) dispose();
    Population.stopPartyAssemblyEvents();
    await DB.close(); fs.rmSync(directory, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = previousConfig;
    console.log('CLEANUP', !fs.existsSync(directory));
});
