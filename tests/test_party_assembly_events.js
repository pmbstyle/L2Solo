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
        classify: state => state.party?.partyId ? null : ({ key: state.stats.request, stamp: `${state.level}:${state.stats.request}`, dueAt: state.deadline || 0 }),
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
    const previous = cache.get(1); const changed = { ...previous, level: 11 };
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
