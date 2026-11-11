'use strict';
// The decision trace: off it records nothing and touches no file; on, a situation, a
// stop and a decision become records of the bot they belong to, scripts/trace.js joins them into "situation →
// decision", a rate past its bound is a counted drop, and the file stays inside its rotation. The lifecycle
// events of parties, trade meetings, clan errands and raids are each recorded once, by their owner, for their event.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('../src/Global');
const { DecisionTraceWriter, FILES } = require('../src/DecisionTraceWriter');
const DecisionTrace = require('../src/GameServer/Bot/DecisionTrace');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Situations = require('../src/GameServer/Bot/Situations');
const Trace = require('../scripts/trace');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-trace-'));
(async () => { try {
    // Off: nothing recorded, no file, no clock.
    const off = DecisionTrace.create({ config: {}, now() { throw Error('off clock'); } });
    assert.equal(off.record({ kind: 'raise', bot: 1 }), false);
    assert.deepEqual(off.stats(), { enabled: false });
    const offWriter = new DecisionTraceWriter(path.join(directory, 'off'), {}, { now() { throw Error('off clock'); } });
    assert.equal(offWriter.write(new Proxy([], { get() { throw Error('off payload'); } })), 0); offWriter.cleanup(); offWriter.rotate();
    assert(!fs.existsSync(path.join(directory, 'off')));

    // On: a far bot's new grade at work waits for its stop (the earning spot, the build and the gear plan hear it);
    // the stop wakes them; the earning spot is taken.
    Config.decisionTrace = true;
    const sent = [];
    DecisionTrace.connect(batch => { sent.push(...batch.records); });
    // A bot holding its answers (with none a decision reads woken).
    const stats = { woken: 0, earning: { spotId: '9_24' }, wishSections: {}, equipmentPlan: null };
    Situations.raise(stats, 'grade_changed', null, Situations.place({ phase: 'cold', activity: 'hunting' }), 501);
    Situations.stop(stats, Situations.REST, 501);
    Situations.decided(stats, 'earning_spot', { caller: 'step', subject: 501, answer: '11_6', was: '9_24' });
    Situations.decided({ woken: 0, earning: { spotId: '9_24' } }, 'earning_spot', { caller: 'party', subject: 502 });
    DecisionTrace.ack(1, sent.length);
    const rows = sent.map(row => JSON.parse(row));
    assert.deepEqual(rows.map(row => [row.bot, row.kind]), [[501, 'raise'], [501, 'stop'], [501, 'decided'], [502, 'decided']]);
    assert.equal(rows[0].name, 'grade_changed'); assert.equal(rows[0].waits, 'earning_spot,build,gear_plan'); assert.equal(rows[0].woke, '');
    assert.equal(rows[1].woke, 'earning_spot,build,gear_plan');
    assert.equal(rows[2].answer, '11_6'); assert.equal(rows[2].was, '9_24'); assert.equal(rows[2].how, 'taken');
    assert.equal(rows[3].how, 'unwoken', 'a decision taken with no situation is named so');
    const summary = Trace.summary(rows);
    assert.equal(summary.pairs['stop@rest → earning_spot (moved)'], 1);
    assert.equal(summary.pairs['unwoken:party → earning_spot (kept)'], 1);
    assert.equal(Trace.line(rows[2]), 'earning_spot taken by step: 11_6 (was 9_24)');

    // A worker's record keeps its candidates' hours through main's queue.
    const forwarded = DecisionTrace.create({ config: { decisionTrace: true }, thread: 'main' }), out = [];
    forwarded.connect(batch => { out.push(...batch.records); });
    const worker = DecisionTrace.create({ config: { decisionTrace: true }, thread: 'worker' }), sentByWorker = [];
    worker.connect(batch => { sentByWorker.push(...batch.records); });
    worker.detail({ bot: 64, phase: 'town_choice', candidates: [{ town: 'Giran', value: 1.5 }] });
    forwarded.accept(sentByWorker);
    assert.deepEqual(JSON.parse(out[0]).candidates, [{ town: 'Giran', hours: 1.5 }], 'hours survive the hop to main');
    assert.equal(JSON.parse(out[0]).thread, 'worker');

    // A far step main refuses re-runs on the moved row: its decisions are recorded once, by the step committed.
    const steps = DecisionTrace.create({ config: { decisionTrace: true }, thread: 'worker', now: () => 5000 }), stepped = [];
    steps.connect(batch => { stepped.push(...batch.records); steps.ack(batch.id, batch.records.length); });
    for (const committed of [false, true]) {
        steps.hold(77);
        steps.record({ kind: 'raise', bot: 77, name: 'goal_done:line' });
        steps.record({ kind: 'decided', bot: 77, decision: 'own_lines', how: 'taken', answer: '0/1' });
        steps.record({ kind: 'raise', bot: 78, name: 'died' });
        steps.settle(77, committed);
    }
    assert.deepEqual(stepped.map(row => JSON.parse(row)).map(row => [row.bot, row.kind, row.at]),
        [[78, 'raise', 5000], [78, 'raise', 5000], [77, 'raise', 5000], [77, 'decided', 5000]], 'the refused step\'s records are not in the trace');
    assert.equal(steps.stats().drops.refused, 2, 'and counted as refused');

    // The rate bound: records past it in one second are dropped and counted; a detail record never takes the
    // decisions' reserve.
    const clock = { at: 1000 }, bounded = DecisionTrace.create({ config: { decisionTrace: true }, thread: 'main', now: () => clock.at });
    let kept = 0;
    for (let i = 0; i < DecisionTrace.LIMITS.perSecond + 10; i++) kept += bounded.record({ kind: 'raise', bot: 7, name: 'died' }) ? 1 : 0;
    assert.equal(kept, DecisionTrace.LIMITS.perSecond);
    assert.equal(bounded.stats().drops.rate, 10, 'every record past the rate is counted');
    clock.at += 1000;
    let details = 0;
    for (let i = 0; i < DecisionTrace.LIMITS.perSecond; i++) details += bounded.detail({ bot: 7, phase: 'funding' }) ? 1 : 0;
    assert(details < DecisionTrace.LIMITS.perSecond && bounded.record({ kind: 'death', bot: 7, killer: 'npc:20001' }),
        'detail records leave the decisions their share');

    // The file: bounded batch split and rotation, an oversized row an explicit loss.
    const writer = new DecisionTraceWriter(directory, { build: 'fixture' }, { enabled: true, maxFile: 1024 });
    const lines = new Array(16).fill(JSON.stringify({ bot: 64, reason: 'x'.repeat(390) }));
    assert.equal(writer.write(lines), 16); assert.equal(writer.snapshot().records, 16);
    assert(writer.snapshot().rotations > 0);
    const names = fs.readdirSync(directory).filter(name => name.startsWith('decision-trace')); assert(names.length <= FILES);
    for (const name of names) { assert(fs.statSync(path.join(directory, name)).size <= 1024);
        for (const line of fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line)); }
    assert.equal(writer.write([JSON.stringify({ reason: 'x'.repeat(950) })]), 0, 'a row that cannot fit is an explicit loss');
    assert.equal(writer.snapshot().dropped, 1);

    await lifecycle();
} finally {
    Config.decisionTrace = false;
    DecisionTrace.stop();
    fs.rmSync(directory, { recursive: true, force: true });
}
console.log('Decision trace: off records nothing, raise/stop/decided per bot, situation → decision summary, counted rate drops, bounded file, lifecycle events once each passed');
})().catch(error => { console.error(error); process.exit(1); });

// Each lifecycle event, raised through its owner, is one record (a repeat of the same fact is none).
async function lifecycle() {
    const events = [];
    DecisionTrace.disconnect();
    DecisionTrace.connect(batch => { events.push(...batch.records.map(row => JSON.parse(row))); DecisionTrace.ack(batch.id, batch.records.length); });
    const take = kind => events.splice(0).filter(row => row.kind === kind)
        .map(row => [row.bot, row.phase, row.outcome, row.reason].map(value => value ?? null));

    // A party request's lifecycle, at the commits that change it (every committed state lands in BotLifeState's
    // cache; the first load is no event): opened, held by the next commit, closed by a leave's commit with the
    // leave's reason (the leave computed alone, as a projection does, records nothing), reopened and ended by joining
    // a party, by the build no longer asking and by a supply pause.
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const commit = (id, patch) => {
        const previous = Life.cachedState(id);
        return Life.acceptSimulationOwnership(id, { revision: Number(previous?.simulation?.revision || 0) + 1 },
            { ...previous, ...patch, characterId: id });
    };
    const ask = at => ({ objectiveKey: 'gear:1', reason: 'gear_acquisition', status: 'open', requestedAt: at, priority: 'required' });
    const { REASON: timeout } = require('../src/GameServer/Bot/Population/PartyHuntingAssembly');
    commit(601, { level: 30, phase: 'hot', activity: 'hunting', loc: { locX: 0, locY: 0, locZ: 0 }, party: {}, stats: {} });
    commit(601, { stats: { partyRequest: ask(1000) } });
    commit(601, { activity: 'party_wait', stats: { partyRequest: ask(1000), backgroundPartyId: null } });
    const left = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle').releaseMember(Life.cachedState(601), 3000,
        timeout, ask(1000));
    assert.deepEqual(take('party'), [[601, 'request', 'open', 'gear_acquisition']], 'opened once; a leave not committed is no close');
    commit(601, left);
    commit(601, { stats: { partyRequest: ask(4000) } });
    commit(601, { party: { partyId: 'bgp_join' }, stats: { partyRequest: null, backgroundPartyId: 'bgp_join' } });
    commit(601, { party: {}, stats: { partyRequest: ask(5000) } });
    commit(601, { stats: { partyRequest: null } });
    commit(601, { stats: { partyRequest: ask(6000) } });
    commit(601, { stats: { partyRequest: { ...ask(6000), status: 'closed', suspendedFor: 'stock:craft' } } });
    assert.deepEqual(take('party'), [[601, 'request', 'closed', timeout], [601, 'request', 'open', 'gear_acquisition'],
        [601, 'request', 'closed', 'joined'], [601, 'request', 'open', 'gear_acquisition'], [601, 'request', 'closed', 'not_needed'],
        [601, 'request', 'open', 'gear_acquisition'], [601, 'request', 'closed', 'supply_pause']], 'every end of a request closed once, with its reason');

    // A party formed (its new row), re-accepted unchanged, a member joined, its raid won, then dissolved (twice).
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const row = (revision, members, stats = {}, status = 'active') => ({ partyId: 'bgp_trace', leaderId: 701, memberIdsJson: JSON.stringify(members),
        spotId: 's1', startedAt: 1, status, statsJson: JSON.stringify({ objective: { reason: 'opportunistic_raid', raidBossTemplateId: 10366 }, ...stats }),
        roleCoverageJson: '{}', updatedAt: revision + 1, revision });
    Parties.acceptRow(row(0, [701, 702]));
    Parties.acceptRow(row(0, [701, 702]));
    Parties.acceptRow(row(1, [701, 702, 703]));
    Parties.acceptRow(row(2, [701, 702, 703], { raidEncounter: { status: 'defeated' } }));
    Parties.acceptRow(row(3, [701, 702, 703], { raidEncounter: { status: 'defeated' }, partyBreakReason: 'raid_defeated' }, 'dissolved'));
    Parties.acceptRow(row(4, [701, 702, 703], { raidEncounter: { status: 'defeated' }, partyBreakReason: 'raid_defeated' }, 'dissolved'));
    const partyRows = events.filter(row => row.kind === 'party' || row.kind === 'raid');
    assert.deepEqual(take('party'), [[701, 'formed', null, 'opportunistic_raid'], [703, 'joined', null, null],
        [701, 'dissolved', 'dissolved', 'raid_defeated']], 'formed, joined and dissolved once each, the end with its reason');
    assert.deepEqual(partyRows.filter(row => row.kind === 'raid').map(row => [row.phase, row.outcome, row.npcId]), [['outcome', 'defeated', 10366]],
        'the raid\'s outcome once, with its boss');
    // A party a required clan hunt reclaims ends with its reason, under the leader it had (the ended row holds none).
    const reclaimed = (revision, status = 'active', stats = {}) => ({ partyId: 'bgp_reclaim', leaderId: 711, memberIdsJson: JSON.stringify([711, 712]),
        spotId: 's1', startedAt: 1, status, statsJson: JSON.stringify(stats), roleCoverageJson: '{}', updatedAt: revision + 1, revision });
    Parties.acceptRow(reclaimed(0));
    events.splice(0);
    const reclaimers = [711, 712].map(characterId => ({ characterId, phase: 'cold', activity: 'grouped', party: { partyId: 'bgp_reclaim' },
        simulation: {}, stats: {} }));
    assert.equal(await require('../src/GameServer/Bot/Population/ClanPartyCapacity').reclaim(
        { status: 'open', priority: 'required', clanId: 77, clanGoalKey: 'clan:77:gear' }, {
            parties: Parties, metrics: { recordPartyDissolution() {} },
            life: { statesForParty: async () => reclaimers, preparePartyReview: (before, after) => ({ before, snapshot: after }), acceptPartyAssignments() {} },
            database: { commitBackgroundPartyMembership: async ({ party }) => ({ ok: true, partyRow: { ...party, revision: 1 } }) } }), true);
    assert.deepEqual(take('party'), [[711, 'dissolved', 'dissolved', 'clan_priority']], 'a reclaimed party ends once, named');

    // A trade meeting prepared, its accept refused (the reason), a second accepted, then delivered once and cancelled once.
    const Meetings = require('../src/GameServer/AfkTrade/TradeMeetingService');
    const Database = invoke('Database');
    const kept = { cached: Life.cachedState, accept: Database.acceptTradeMeeting, drain: Database.withoutMutationAdmission };
    const trader = { characterId: 801, phase: 'cold', activity: 'shopping', simulation: { revision: 0 }, stats: {} };
    const side = { phase: 'cold', revision: 0, hotAt: 0, sequence: 1, needRevision: 0, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } };
    const deal = token => ({ token, actorA: 801, actorB: 802, seqA: 1, seqB: 1, town: 'Giran', point: { locX: 0, locY: 0, locZ: 0 },
        parties: [side, { ...side }], lines: [{ payer: 0, itemId: 3, selfId: 1867, count: 1, price: 10 }] });
    try {
        Life.cachedState = () => trader;
        Database.withoutMutationAdmission = () => {};
        Database.acceptTradeMeeting = async () => { throw Error('trade_meeting_need_changed'); };
        Meetings.stage(deal('trace-refused'));
        await assert.rejects(Meetings.accept('trace-refused'));
        const meeting = { id: 9, token: 'trace-accepted', actorA: 801, actorB: 802, state: 'accepted', revision: 1, locX: 0, locY: 0, locZ: 0 };
        Database.acceptTradeMeeting = async () => ({ meeting, pending: true });
        Meetings.stage(deal('trace-accepted'));
        await Meetings.accept('trace-accepted');
        Meetings.acceptRows({ meeting: { ...meeting, state: 'completed', reason: 'arrived' }, closed: [] });
        Meetings.acceptRows({ meeting: { ...meeting, state: 'completed', reason: 'arrived' } });
        Meetings.acceptRows({ meeting: { ...meeting, id: 10, state: 'cancelled', reason: 'route_unfunded' }, closed: [] });
    } finally { Life.cachedState = kept.cached; Database.acceptTradeMeeting = kept.accept; Database.withoutMutationAdmission = kept.drain; Meetings.reset(); }
    assert.deepEqual(take('meeting'), [[801, 'prepared', null, null], [801, 'refused', null, 'trade_meeting_need_changed'],
        [801, 'prepared', null, null], [801, 'accepted', null, null], [801, 'delivered', null, 'arrived'], [801, 'cancelled', null, 'route_unfunded']],
        'each meeting event once, a refusal and a cancel with their reasons');

    // A clan errand's lifecycle, at the commits that change the bot's errands: taken, bought in part (no event), filled
    // (done); another dropped with the commit's reason (failed), a third run out of time (lapsed). A bot's own
    // errand, or one with no clan, is none.
    const Errands = require('../src/GameServer/Bot/Population/CombinedErrandPolicy');
    const errand = (selfId, at, amount, clanId = 3) => ({ town: 'Giran', selfId, amount, at, purpose: 'clan', tag: { clanId, clanPart: 100 } });
    commit(901, { level: 30, phase: 'cold', activity: 'hunting', loc: { locX: 0, locY: 0, locZ: 0 }, updatedAt: 10, stats: {} });
    events.splice(0);
    commit(901, { updatedAt: 11, stats: { marketErrands: [errand(1867, 5, 2), errand(1868, 5, 1, 0), { ...errand(1869, 5, 1), purpose: 'supply' }] } });
    commit(901, { updatedAt: 12, stats: { marketErrands: [errand(1867, 5, 1)], lastErrand: { purpose: 'clan', selfId: 1867, units: 1, at: 12 } } });
    commit(901, { updatedAt: 13, stats: { marketErrands: [], lastErrand: { purpose: 'clan', selfId: 1867, units: 1, at: 13 } } });
    commit(901, { updatedAt: 14, stats: { marketErrands: [errand(1870, 14, 1), errand(1871, 14, 1)] } });
    commit(901, { updatedAt: 15, stats: { marketErrands: [errand(1871, 14, 1)], lastReason: 'market_errand_need_changed' } });
    commit(901, { updatedAt: 14 + Errands.ERRAND_MS, stats: { marketErrands: [] } });
    const errandRows = events.filter(row => row.kind === 'errand');
    assert.deepEqual(take('errand'), [[901, 'taken', null, null], [901, 'done', null, null], [901, 'taken', null, null], [901, 'taken', null, null],
        [901, 'failed', null, 'market_errand_need_changed'], [901, 'lapsed', null, null]], 'each clan errand event once, an end with its outcome');
    assert.deepEqual(errandRows.map(row => [row.errandKey, row.item]), [['clan:3', 1867], ['clan:3', 1867], ['clan:3', 1870], ['clan:3', 1871],
        ['clan:3', 1870], ['clan:3', 1871]], 'under its clan and item');

    // A raid search woken at the director's start forms a roster's party: forming once, the search once.
    const Policy = invoke('GameServer/Bot/Population/OpportunisticRaidPolicy');
    const { OpportunisticRaidDirector } = require('../src/GameServer/Bot/Population/OpportunisticRaidDirector');
    const roster = Array.from({ length: 9 }, (_, i) => ({ characterId: 950 + i, level: 30 }));
    const steps = { candidates: Policy.candidateSteps, proposals: Policy.proposalSteps,
        ready: Policy.candidateReady, composition: Policy.composition, compatible: Policy.compatible };
    Policy.candidateReady = () => true; Policy.composition = () => ({ ready: true }); Policy.compatible = () => true;
    Policy.candidateSteps = function* () { yield* []; return { candidates: roster, proposals: [roster], rejected: {}, tankCursor: 0, priorityKey: null }; };
    Policy.proposalSteps = function* () { yield* []; return [roster]; };
    const spot = { id: 'raid:10366', raidBossTemplateId: 10366, avgLevel: 30 };
    const director = new OpportunisticRaidDirector({ database: { execute: async () => [] },
        config: { opportunisticRaidMemberCooldownMs: 0, opportunisticRaidIntervalMs: 1, opportunisticRaidMaxParties: 2, opportunisticRaidAliveFraction: 0 },
        life: { cachedState: id => roster.find(s => s.characterId === id), statesByIds: async ids => roster.filter(s => ids.includes(s.characterId)), subscribePublications: () => () => {} },
        parties: { admitted: () => [], subscribeChanges: () => () => {} },
        catalog: { all: () => [spot], liveTemplateIds: () => new Set([10366]) },
        memory: { ensureMany: async () => {}, assess: () => ({ ready: true }) }, canWork: () => true, bossFree: () => true,
        assess: async () => ({ ready: true, supplies: [] }),
        form: async (members, objective) => ({ partyId: 'bgp_raid', memberIds: members.map(s => s.characterId), startedAt: 10, stats: { objective } }) });
    try {
        await director.start();
        await director.pulse(Date.now());
    } finally { director.stop(); Object.assign(Policy, { candidateSteps: steps.candidates, proposalSteps: steps.proposals,
        candidateReady: steps.ready, composition: steps.composition, compatible: steps.compatible }); }
    assert.deepEqual(take('raid'), [[950, 'forming', 'formed', null], [null, 'search', 'formed', 'start']], 'the roster formed once, its search once');
    assert.equal(Trace.line({ kind: 'raid', phase: 'forming', outcome: 'formed', party: 'bgp_raid', npcId: 10366 }), 'raid forming formed bgp_raid boss 10366');
    assert.equal(Trace.summary([{ kind: 'errand', phase: 'failed', reason: 'no_source', bot: 1, at: 1 }]).lifecycle['errand failed (no_source)'], 1);
}
