process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
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
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        // Each bot holds its earning answer (forming skips a candidate with none).
        stats: { classId: 0, earning: { spotId: 'event-fixture', shots: true, income: 0, earning: 0, error: 0, at: 0 }, ...stats } }, 'assembly_fixture');
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
    // Cold members' party goals come from the cold worker (absent here); answer
    // as the worker does so formation runs its real path to the commit.
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const GoalPolicy = require('../src/GameServer/Bot/Population/PartyGoalPolicy');
    const GoalCalculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
    const originalPartyGoals = Coordinator.requestPartyGoals;
    // This event fixture has no world/spot atlas. Supply a reachable party
    // goal with no solo route; the economic policy has its own native tests.
    const Income = require('../src/GameServer/Bot/Population/PartyProgressComparison');
    const originalIncome = Income.compare;
    Income.compare = (_state, _peers, options) => ({ ...Income.evaluate({ solo: null, party: { income: 1000 }, cash: 5000 }),
        at: options.prepared.timestamp, soloSource: null, partySource: null });
    disposers.push(() => { Income.compare = originalIncome; });
    Coordinator.requestPartyGoals = async (party, selected) => ({ ok: true,
        sources: GoalCalculation.sources(selected), joint: party.stats.forming
        ? GoalPolicy.formingVerdict(selected, party.stats.forming.requested) : GoalPolicy.joint(party, selected) });
    const clock = { now: Date.now() }, jobs = registry(clock);
    const driver = new PartyAssemblyEvents({ registry: jobs, life: Life, parties: Parties,
        classify: state => Population.partyAssemblyInput(state),
        run: (rows, timestamp, help) => Population.runPartyAssemblyEvent(rows, timestamp, help),
        onError: error => errors.push(error) });
    disposers.push(() => driver.stop()); driver.start(); await flush();
    jobs.tick(clock.now); await flush();
    for (let turns = 0; driver.running && turns < 500; turns++) await flush();
    const joinedA = Life.cachedState(a.characterId), joinedB = Life.cachedState(b.characterId);
    assert(joinedA.party.partyId, 'event-driven native formation creates a real party');
    assert.equal(joinedA.party.partyId, joinedB.party.partyId);
    const [nativeParty] = await DB.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', [joinedA.party.partyId]]);
    assert.deepEqual(JSON.parse(nativeParty.memberIdsJson).sort((x, y) => x - y), [a.characterId, b.characterId]);
    driver.stop();
    Config.partyMaxSize = 3;
    const material = { ...request, reason: 'craft_material', materialParty: true, strategy: 'craft',
        objectiveKey: 'craft-material:event-fixture', itemId: 4097, amount: 12, requiredTotal: 12, targetId: 5726 };
    const owners = [await seed({ classId: 8, role: 'dps', equipmentPlan: { target: { selfId: 5726 } }, partyRequest: material }),
        await seed({ classId: 8, role: 'dps', equipmentPlan: { target: { selfId: 5730 } },
            partyRequest: { ...material, itemId: 4098, npcId: 20004, targetId: 5730 } })];
    const support = await seed({ classId: 16, role: 'healer', persona: { traits: { sociability: 0 } } });
    const materialStates = [];
    for (const [index, member] of [...owners, support].entries()) {
        await DB.execute(['UPDATE characters SET level=65 WHERE id=?', [member.characterId]]);
        materialStates.push(await Life.upsertState({ ...member, level: 65, clanId: index + 1,
            activity: member === support ? 'hunting' : 'party_wait',
            spotId: member === support ? 'remote-support-camp' : 'event-fixture' }, 'material_assembly_fixture'));
    }
    const made = await Population.formBackgroundParties(materialStates);
    assert.equal(made.length, 1);
    const materialParty = made[0];
    assert.deepEqual(new Set(materialParty.memberIds), new Set(materialStates.map(member => member.characterId)),
        'native formation commits different material owners and a remote support to one mixed party');
    assert.equal(materialParty.stats.agreement.mode, 'need');
    assert.deepEqual(materialParty.stats.agreement.materialNeeds.map(goal => goal.itemId).sort(), [4097, 4098]);
    const [storedMaterial] = await DB.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', [materialParty.partyId]]);
    assert.deepEqual(JSON.parse(storedMaterial.statsJson).agreement.materialNeeds.map(goal => goal.quota), [12, 12]);
    for (const member of materialStates) assert.equal(Life.cachedState(member.characterId).party.partyId, materialParty.partyId);
    console.log('PASS native material membership commit with two needs, different clans and a remote support');
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const savedCache = Profiles.cache;
    const limited = [];
    for (const stats of [
        { classId: 8, role: 'dps', equipmentPlan: { target: { selfId: 5726 } }, partyRequest: material },
        { classId: 8, role: 'dps', equipmentPlan: { target: { selfId: 5726 } }, partyRequest: material },
        { classId: 16, role: 'healer' }
    ]) {
        const member = await seed(stats);
        limited.push(await Life.upsertState({ ...member, level: 65,
            activity: 'hunting', spotId: 'event-fixture' }, 'limited_material_fixture'));
    }
    Profiles.cache = [{ id: 'event-fixture', capacity: 2, center: { locX: 0, locY: 0, locZ: 0 } }];
    try {
        const fitted = await Population.formBackgroundParties(limited);
        assert.equal(fitted.length, 1);
        // Room is checked at arrival (ARCH-08-a), not at formation: a spot of
        // capacity 2 does not cut the chosen support from the roster.
        assert.deepEqual(new Set(fitted[0].memberIds), new Set(limited.map(member => member.characterId)),
            'formation keeps every chosen member; the spot room is not a formation gate');
        assert(Life.cachedState(limited[2].characterId).party?.partyId);
    } finally { Profiles.cache = savedCache; }
    // Forming's no closes the refused roster's requests (their next build reopens them, a
    // move of its group); a closed request asks no retry.
    {
        // A busy worker gives no verdict: no request closes (the roster is asked again on its members' rows).
        Coordinator.requestPartyGoals = async () => ({ ok: false, reason: 'party_goal_busy' });
        Config.partyMaxSize = 2;
        const busyAsk = { ...request, objectiveKey: 'event-fixture:busy', requestedAt: Date.now() };
        const busyPair = [await seed({ partyRequest: busyAsk }), await seed({ partyRequest: busyAsk })];
        assert.deepEqual(await Population.formBackgroundParties(busyPair), []);
        assert(busyPair.every(state => Life.cachedState(state.characterId).stats.partyRequest.status === 'open'),
            'a busy worker closes no request');
        let asks = 0;
        Coordinator.requestPartyGoals = async (party, selected) => { asks++; return { ok: true,
            sources: GoalCalculation.sources(selected), joint: GoalPolicy.formingVerdict(selected, party.stats.forming.requested) }; };
        Income.compare = (_state, _peers, options) => ({ ...Income.evaluate({ solo: { income: 5000 }, party: { income: 10 }, cash: 5000 }),
            at: options.prepared.timestamp, soloSource: null, partySource: null });
        Config.partyMaxSize = 2;
        const refused = { ...request, objectiveKey: 'event-fixture:refused', requestedAt: Date.now() };
        const pair = [await seed({ partyRequest: refused }), await seed({ partyRequest: refused })];
        assert.deepEqual(await Population.formBackgroundParties(pair), []);
        assert.equal(asks, 1);
        assert(pair.every(state => Life.cachedState(state.characterId).stats.partyRequest.status === 'closed'
            && Life.cachedState(state.characterId).stats.partyRequest.lastReason === 'forming_refused'), 'forming\'s no closes both requests');
        const answer = await Population.runPartyAssemblyEvent(pair.map(state => Life.cachedState(state.characterId)), Date.now());
        assert.equal(asks, 1, 'a closed roster is not judged again on a move');
        assert(!answer.deferred, 'a refused roster asks no retry');
        // Their next builds reopen the requests.
        const fresh = [];
        for (const state of pair) {
            const current = Life.cachedState(state.characterId);
            fresh.push(await Life.upsertState({ ...current, stats: { ...current.stats,
                partyRequest: { ...current.stats.partyRequest, status: 'open' } } }, 'reopened_fixture'));
        }
        await Population.formBackgroundParties(fresh, { moved: new Set([999999]) });
        assert.equal(asks, 1, 'a roster none of whose members moved is not judged again');
        await Population.formBackgroundParties(fresh, { moved: new Set([Number(pair[0].characterId)]) });
        assert.equal(asks, 2, 'a roster with a moved member is judged');
        const closed = await Life.upsertState({ ...pair[1], stats: { ...pair[1].stats, partyRequest: { ...refused,
            status: 'closed', lastReason: 'party_assembly_timeout' } } }, 'closed_member_fixture');
        assert(!(await Population.runPartyAssemblyEvent([closed], Date.now())).deferred,
            'a closed request asks no retry: its next build wakes the group');
        Income.compare = (_state, _peers, options) => ({ ...Income.evaluate({ solo: null, party: { income: 1000 }, cash: 5000 }),
            at: options.prepared.timestamp, soloSource: null, partySource: null });
    }
    console.log('PASS forming\'s no closes a refused roster\'s requests; a closed request asks no retry');
    Population.started = false; Population.playerActivityProfile = savedProfile;
    Coordinator.requestPartyGoals = originalPartyGoals;
    Income.compare = originalIncome;
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
        // A party is due for its member plans only when its roster, its
        // objective or its pending recruits change, never on its own plan write.
        const due = Population.partyRequirementRefreshDue, base = cacheParties[0], id = base.partyId;
        due.clear();
        Population.markPartyRequirementsDue({ ...base, stats: { acquisitionGoal: { status: 'active' } } }, base);
        assert.equal(due.size, 0, 'the apply\'s own goal write marks nothing');
        Population.markPartyRequirementsDue({ ...base, memberIds: [...base.memberIds, 999] }, base);
        assert(due.has(id), 'a new member marks the party due');
        due.clear();
        Population.markPartyRequirementsDue({ ...base, stats: { objective: { objectiveKey: 'spot:B' } } }, base);
        assert(due.has(id), 'a new objective marks the party due');
        Population.markPartyRequirementsDue({ ...base, status: 'dissolved' }, base);
        assert.equal(due.size, 0, 'a dissolved party drops its mark');
    } finally { DB.execute = originalExecute; Parties.active = originalActive; unpublish(); Population.partyRequirementRefreshDue?.clear(); }
    console.log('PASS five-party cache reads, no publications, cache authority and addressed refresh marks');

    // The apply's own party write (its new objective) publishes through the
    // same subscription as any change; the due delete after its last write
    // erases that mark, so a re-plan never triggers the next one.
    {
        const owner = await seed(), other = await seed(), partyId = 'apply-own-write';
        for (const member of [owner, other]) await Life.upsertState({ ...member, activity: 'grouped',
            party: { partyId, leaderId: owner.characterId } }, 'apply_fixture');
        await Parties.createOrUpdate({ partyId, leaderId: owner.characterId, memberIds: [owner.characterId, other.characterId],
            status: 'active', spotId: 'event-fixture', stats: { objective: { objectiveKey: 'spot:old' } } });
        const unsubscribe = Parties.subscribeChanges((party, previous) => Population.markPartyRequirementsDue(party, previous));
        try {
            Population.partyRequirementRefreshDue.clear();
            await Population.applyWorkerPartyRequirements(Parties.find(partyId), { memberPlans: [], requirementRefreshedAt: true });
            assert.equal(Parties.find(partyId).stats.objective, null, 'the apply wrote its own new objective');
            assert.equal(Population.partyRequirementRefreshDue.has(partyId), false, 'the apply\'s own writes leave no mark');
        } finally { unsubscribe(); Population.partyRequirementRefreshDue.clear(); }
    }
    console.log('PASS the re-plan apply marks nothing by its own writes');

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
    stampService.dirty.clear();
    stampPartyListener({ partyId: 'dissolved-A', status: 'dissolved', spotId: 'A', memberIds: [] },
        { status: 'active', spotId: 'A', memberIds: [] });
    assert.deepEqual([...stampService.dirty], ['spot:A'], 'dissolve wakes only its hunting spot');
    stampService.dirty.clear();
    // Only a bot that seeks a party (an open request) is a candidate at its moves: a willing
    // bot arriving wakes nothing; the seeker's level does; any member leaving a group that
    // holds a seeker wakes it; a roster refused at its commit wakes at its member's next row.
    stampCache.set(4003, { characterId: 4003, phase: 'cold', level: 30, activity: 'hunting', spotId: 'A', inventory: {}, adena: 0, stats: { classId: 0 } });
    await flush();
    assert.equal(stampService.dirty.size, 0, 'a willing bot\'s arrival wakes nothing');
    stampCache.set(4001, { ...stampCache.get(4001), level: 31 });
    await flush();
    assert.deepEqual([...stampService.dirty], ['spot:A'], 'the seeker\'s level moves its roster\'s range');
    stampService.dirty.clear();
    stampCache.set(4003, { ...stampCache.get(4003), activity: 'traveling' });
    await flush();
    assert.deepEqual([...stampService.dirty], ['spot:A'], 'a member leaving a seeker\'s group wakes it');
    assert(stampService.groups.get('spot:A').moved.has(4001), 'its seeker\'s rosters are judged');
    stampService.dirty.clear();
    stampCache.set(4002, { ...stampCache.get(4002), adena: 5 });
    await flush();
    assert.equal(stampService.dirty.size, 0, 'a willing bot\'s loot wakes nothing');
    stampService.rewakeOn([stampCache.get(4002)]);
    assert.equal(stampService.dirty.size, 0, 'a refused roster on unmoved rows waits for their next publication');
    stampCache.set(4002, { ...stampCache.get(4002), adena: 6 });
    await flush();
    assert.deepEqual([...stampService.dirty], ['spot:B'], 'a refused commit wakes at its member\'s next published row');
    stampService.dirty.clear();
    const judged = stampCache.get(4002);
    stampCache.set(4002, { ...judged, adena: 7 });
    await flush();
    assert.equal(stampService.dirty.size, 0);
    stampService.rewakeOn([judged]);
    assert.deepEqual([...stampService.dirty], ['spot:B'], 'a roster refused on a row that has moved since runs at once');
    stampService.dirty.clear();
    stampService.waitSlot([stampCache.get(4002)]);
    stampPartyListener({ partyId: 'dissolved-C', status: 'dissolved', spotId: 'C', memberIds: [] },
        { status: 'active', spotId: 'C', memberIds: [] });
    assert.deepEqual([...stampService.dirty], ['spot:B'], 'a roster refused for want of a slot runs when any party ends');
    stampService.stop(); console.log('PASS waking stamp, 100 loot publications, request edge and one-spot dissolve');

    // Actual cache and common registry, controlled decision callback. Safety
    // uses pages of retained rows; no population iterator/planner is needed.
    const cache = new Cache(), tick = { now: 1000 }, queue = registry(tick);
    const sources = Array.from({ length: 200 }, (_, index) => ({ characterId: index + 1, phase: 'cold',
        activity: 'hunting', level: 10, updatedAt: 1, loc: { locX: index, locY: 0, locZ: 0 },
        stats: { request: index < 2 ? 'pair' : `solo${index}` }, timing: {} }));
    sources.forEach(row => cache.set(row.characterId, row));
    const pages = [], attempts = [], repairs = [];
    const life = { cachedState: id => cache.get(id), subscribePublications: (...args) => cache.subscribePublications(...args),
        async safetyPage({ afterId = 0, highWaterId = 200, limit }) {
            assert.equal(limit, 64); const ids = sources.map(row => row.characterId).filter(id => id > afterId && id <= highWaterId).slice(0, limit);
            pages.push(ids.length);
            return { rows: ids.map(characterId => ({ characterId })), cursor: { afterId: ids.at(-1) || highWaterId, highWaterId }, done: !ids.length || ids.at(-1) === highWaterId };
        } };
    let partyListener, defer = false;
    const service = new PartyAssemblyEvents({ registry: queue, life, parties: { subscribeChanges(fn) { partyListener = fn; return () => { partyListener = null; }; } },
        now: () => tick.now, retryMs: 100,
        classify: state => state.party?.partyId ? null : ({ key: state.stats.request, seeks: true, stamp: [state.level, null, null, state.stats.request, state.stats.status || null, null, null, null] }),
        run(rows, timestamp, help) { attempts.push({ rows, help }); return { deferred: defer }; },
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
    // A group the running formation kept waiting (busy) sets no clock: it runs when that formation ends.
    let busy = true;
    const runBusy = service.run;
    service.run = (rows, timestamp, help) => { attempts.push({ rows, help }); return busy ? { busy: true } : {}; };
    for (const group of service.groups.values()) group.handled = group.revision;
    service.dirty.clear();
    cache.set(1, { ...cache.get(1), stats: { ...cache.get(1).stats, status: 'closed' } }); queue.tick(tick.now); await flush();
    const parked = attempts.length;
    assert(!service.deadlines.has(service.groups.get('pair')), 'a busy group arms no retry');
    tick.now += 1000; queue.tick(tick.now); await flush(); assert.equal(attempts.length, parked);
    busy = false; service.wakeParked(); queue.tick(tick.now); await flush();
    assert.equal(attempts.length, parked + 1, 'the formation\'s end runs the waiting group');
    service.run = runBusy;
    const latest = cache.get(1);
    service.observe({ characterId: 1, state: previous }); assert.equal(service.records.get(1).state, latest);
    partyListener({ partyId: 'real-membership-event', memberIds: [1], status: 'active' }, { memberIds: [], status: 'active' });
    service.wakeHelp(); queue.tick(tick.now); await flush(); assert.equal(attempts.at(-1).help, true);
    console.log('PASS bounded event/coalescing/current-ref, real retry deadline, membership/help and unchanged pulse controls');

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

    assert.equal(Workshop.producerStatus, undefined);
    assert.equal(errors.length, 0, errors.map(error => error?.stack || String(error)).join('\n'));
    console.log('PASS producer rank removed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const dispose of disposers.reverse()) dispose();
    Population.stopPartyAssemblyEvents();
    await DB.close(); fs.rmSync(directory, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = previousConfig;
    console.log('CLEANUP', !fs.existsSync(directory));
});
