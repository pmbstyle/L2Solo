// The spot aggregate at an arrival (SpotContest): a far bot's
// trip ends on a spot, in the background thread, and meets the units standing there
// once, by per-target pressure (the hunters on its target species against that
// species' share of the room); bots still on their way do not count, an arrival
// waiting for its ack does. Over room who holds the spot is decided by look: avoid
// marks the spot (contest_lost wakes the earning spot, the mark lasts the outing); a
// stronger arrival stays and the bots it displaces hear contest_lost at their next
// step once its commit is acked (a refused commit displaces no one); a PvP dispute
// waits for the arriving commit's ack; a party is met as a whole through its leader,
// except at its own objective spot; a unit that arrives on a player's command never avoids;
// a near bot's spot assignment on main (its near post) reaches the worker, counts as
// standing and is itself an arrival there.
const assert = require('node:assert/strict');
const path = require('node:path');
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const NPC = 20001;
invoke('GameServer/Clan/ClanService').syncColdMember = () => {};
invoke('GameServer/Social/InteractionMemoryRuntime').repository = { loadMany: async ids => ids.map(Policy.empty) };
Object.assign(invoke('GameServer/Clan/ClanSocialRuntime'), { refresh: async () => {}, enforceOne: async () => {}, send: () => {} });
const root = path.resolve(__dirname, '..');

// Runs inside the worker: a solo trip started by the real trip builder,
// resolved by the real resolver at its arrival, projected by the kernel's
// projectResolve; a party arrival through the kernel's partyArrival option.
const observer = String.raw`
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PartyRisk = require('./PartySpotRiskPolicy');
const Catalogue = invoke('GameServer/Bot/Situations');
// The contest itself is pinned by its pure part (above); here its wiring: what it
// is given, and a forced outcome (forced) over a real over-room verdict.
const Contest = require('./SpotContest'), realContest = Contest.contest;
let forced = null, seen = null;
Contest.contest = input => {
    const verdict = realContest(input);
    seen = { pressure: verdict.pressure, standing: input.standing.map(unit => unit.key).sort(), hot: input.standing.filter(unit => unit.hot).length,
        npcId: input.npcId, holds: input.arriving.holds, arriving: input.arriving.key, action: verdict.action, reason: verdict.reason,
        displaced: verdict.displaced || [] };
    const peer = input.standing.find(unit => !unit.hot);
    if (!forced || !(verdict.pressure > 1) || !peer) return verdict;
    if (forced === 'coexist') return { action: 'coexist', pressure: verdict.pressure };
    if (forced !== 'pvp') return { action: 'avoid', reason: forced, pressure: verdict.pressure, spotId: String(input.spot.id) };
    return { action: 'stay', reason: 'pvp', displaced: [], pressure: verdict.pressure, peer, event: { at: input.at, key: 'forced:' + input.arriving.key,
        spotId: input.spot.id, npcId: input.npcId, actor: { id: input.arriving.id }, peer: { id: peer.id }, action: 'contest', pvpIntent: true } };
};
const marksOf = stats => Risk.spotMarks(stats).map(mark => mark.spotId + ':' + mark.reason);
const own = new Map();
module.exports.probe = async ({ kind, id, spotId, reason, remove, party, outcome = null, ok = true, keep = false, inventory = null, by = 0, clear = false, at = 1 }) => {
    if (kind !== 'memory') for (const gone of remove || []) kernel.remove(gone);
    forced = outcome; seen = null;
    if (kind === 'standing') return kernel.occupancy.physicalCount(spotId, { standingOnly: true });
    if (kind === 'wake') return kernel.states.get(id)?.stepWake?.raises?.contest_lost || null;
    // Their relationships loaded (a stranger unread is never displaced).
    if (kind === 'memory') { for (const m of remove) kernel.interactionMemory.accept(require('../../Social/InteractionMemoryPolicy').empty(m)); return true; }
    if (kind === 'near') return { marks: marksOf(kernel.states.get(id)?.state.stats), seen };
    // A standing bot's earning answer on a player's command (by: the player) on the spot, or back to its own.
    if (kind === 'command') {
        const s = kernel.states.get(id).state, Income = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
        if (by && !own.has(id)) own.set(id, s.stats.earning);
        const earning = by ? Income.commanded(s.stats.earning, spotId, at, by) : own.get(id);
        if (!by) own.delete(id);
        return kernel.upsert({ state: { ...s, stats: { ...s.stats, earning } } });
    }
    // The bot's next step raises what other owners woke it with (kernel stepWake), as its step
    // does; then that step is answered (keep: not yet). Its command, its earning spot's wake and its next spot.
    if (kind === 'step') {
        const record = kernel.states.get(id), state = record.state, ended = () => Catalogue.counts().raised['command:displaced'] || 0;
        const was = ended();
        let stats = { ...state.stats };
        for (const [name, payload] of Object.entries(record.stepWake?.raises || {})) stats = Catalogue.raise(stats, name, payload, Catalogue.place(state), id);
        if (!keep) record.stepWake = null;
        const after = { ...state, stats }, Income = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
        return { commanded: Income.isCommanded(stats.earning), woken: Catalogue.woken(stats, 'earning_spot'), ended: ended() - was,
            next: require('./BotRoute').huntSpot(after, null, { spots: planningSpots, timestamp: Date.now() })?.spotId ?? null };
    }
    // Arrivals in flight on the spot (each: [id, the ids it displaces]), as the outbox holds them
    // until their acks; clear: forget them.
    if (kind === 'flight') {
        for (const [unitId, displaced] of party) {
            if (clear) { outbox.pending.delete(unitId); continue; }
            const s = kernel.states.get(unitId).state;
            outbox.arrive(unitId, 'flight:' + unitId, { spotId, at: Date.now(), displaced, unit: { key: 'solo:' + unitId, id: unitId, name: s.name,
                partyId: null, size: 1, hunters: 1, level: s.level, members: [s], state: s, npcId: ${NPC}, holds: null, hot: false } });
        }
        return true;
    }
    if (kind === 'ack') {
        // The commit ack as the worker hears it (contestAcked), then the next heartbeat's frame.
        const before = outbox.pending.has(id), counts = () => Catalogue.counts().raised;
        const drops = ['stale', 'unsent', 'arrival_refused'], was = drops.map(why => counts()['spot:contest:' + why] || 0);
        contestAcked([{ characterId: id, ok, proposalId: reason }]);
        const frame = outbox.reviewBatch(Date.now());
        const sent = frame ? frame.events.map(event => event.action) : [];
        if (frame) outbox.receipt({ frameId: frame.frameId, at: frame.at, status: 'accepted' });
        return { before, after: outbox.pending.has(id), sent,
            ...Object.fromEntries(drops.map((why, i) => [why, (counts()['spot:contest:' + why] || 0) - was[i]])) };
    }
    if (kind === 'party') {
        const members = party.memberIds.map(member => kernel.states.get(member).state);
        const out = kernel.partyArrival({ party, members, spotId, timestamp: Date.now(), proposalOf: () => 'party-step' });
        const queued = outbox.pending.get(party.leaderId)?.events.length > 0;
        outbox.pending.delete(party.leaderId);
        if (!out) return { out: null, seen, outbox: queued };
        const answered = { ...out.party, stats: { ...out.party.stats, partySpot: { spotId: null, at: 1 } } };
        return { excluded: [...PartyRisk.excludedSpotIds(out.party)], lapsed: [...PartyRisk.excludedSpotIds(answered)],
            wait: out.party.stats.coldCompetition?.wait || null, leaderMarks: marksOf(out.members[0].stats),
            memberMarks: marksOf(out.members[1].stats), seen };
    }
    const { beginHuntingTrip } = require('./HuntingTravel');
    const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const held = kernel.states.get(id), now = Date.now();
    const entry = inventory ? { ...held, state: { ...held.state, inventory } } : held;
    const to = { locX: 50000, locY: -176000, locZ: -1000 };
    // A solo trip takes its own time: started that long ago, it has arrived by now.
    const tripMs = require('./ColdTrip').spotPlan(entry.state, to).durationMs;
    const traveling = beginHuntingTrip(entry.state, { needed: true, mode: 'solo', spotId, regionName: 'Room',
        to, destinations: { [id]: to }, travelMs: 1000, reason }, now - 5000 - tripMs);
    const result = BackgroundResolver.resolveSolo({ state: traveling, timestamp: now });
    // The arriving step in flight (its commit's proposal keys the outbox).
    kernel.inFlight.set(id, { state: traveling, startedAt: now, dueAt: now });
    const contested = soloArrival(traveling, result, now);
    kernel.inFlight.delete(id);
    const stats = (contested || result).patch.stats;
    const queued = outbox.pending.get(id)?.events[0]?.action || null;
    const proposalId = outbox.pending.get(id)?.proposalId || null;
    const arrival = outbox.pending.get(id)?.arrival || null;
    if (!keep) outbox.pending.delete(id);
    return { standingAfter: arrival ? arrival.unit.key : null, displaced: arrival?.displaced || [], arrived: result.patch.activity === 'hunting' && result.patch.spotId === spotId, changed: !!contested,
        marks: marksOf({ ...traveling.stats, ...stats }), woken: Catalogue.woken({ ...traveling.stats, ...stats }, 'earning_spot'),
        wait: stats.coldCompetition?.wait || null, outbox: queued, proposalId, seen };
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.probe) return;
    loaded.exports.probe(message.probe).then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;

const room = { id: 'room-at-arrival', name: 'Room at arrival', center: { locX: 50000, locY: -176000, locZ: -1000 },
    minLevel: 18, maxLevel: 24, avgLevel: 21, density: 12, capacity: 2, levelCounts: { 20: 6 },
    npcEntries: [{ selfId: NPC, count: 2, level: 21 }] };
const away = { ...room, id: 'room-away', name: 'Away field', center: { locX: 20000, locY: -176000, locZ: -1000 }, capacity: 20 };

function bot(characterId, extra = {}) {
    const now = Date.now();
    return { characterId, name: `Room${characterId}`, accountName: `bot_room_${characterId}`, phase: 'cold',
        activity: 'hunting', level: 20, exp: 0, sp: 0, adena: 1000, currentRegion: away.name, spotId: away.id,
        loc: { ...away.center }, inventory: {}, vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
        stats: { classId: 0, classProgressionClassId: 0, classProgressionLevel: 20, generatedCold: true, stepCount: 7,
            equipmentPlan: { status: 'active', next: { npcId: NPC } }, woken: 0,
            earning: { spotId: away.id, shots: true, income: 0, expected: 0, earning: 0, error: 0, at: 1 } },
        timing: { lastResolvedAt: now - 10000, nextResolveAt: now + 600000 }, ...extra };
}

// The contest's own rule, pure: no contest under room; over room the arriving unit compares
// itself by look (weapon and armour grade, people) with each standing unit: a stranger that
// looks stronger turns it away (outmatched); else it displaces the weakest strangers it
// looks stronger than down to room, standing parties and bodies near a player never; else
// (even) clanmates share under twice the room, a stranger may dispute it by PvP, and
// otherwise the first come holds the spot; a unit that holds its ground never avoids.
// Rolls forced to 0: every can-I-win roll is willing.
invoke('GameServer/DataCache').init();
{
    const Contest = require('../src/GameServer/Bot/Population/SpotContest');
    const Situations = invoke('GameServer/Bot/Situations');
    const Tendency = require('../src/GameServer/Bot/AI/TendencyRoll'), roll = Tendency.roll;
    Tendency.roll = () => 0;
    try {
        const spot = { id: 'pure-spot', npcEntries: [{ selfId: NPC, count: 1 }, { selfId: NPC + 1, count: 1 }] };
        // A weapon and body armour of one grade ('none': no grade).
        const gear = grade => ({ weapon: { rank: grade, equippedSlots: [7] }, body: { rank: grade, equippedSlots: [10] } });
        const state = (id, level, grade) => ({ characterId: id, name: `P${id}`, level, stats: {}, simulation: { revision: 1 }, inventory: gear(grade) });
        const unit = (id, grade = 'none', extra = {}) => ({ key: `solo:${id}`, id, name: `P${id}`, partyId: null, size: 1, level: extra.level || 20,
            hunters: 1, members: [state(id, extra.level || 20, grade)], state: state(id, extra.level || 20, grade), npcId: NPC, hot: false, ...extra });
        let clans = {}, unloaded = new Set();
        const memory = { assess: (a, b) => ({ ready: !unloaded.has(b.id) && !unloaded.has(a.id), revision: 1, disposition: 'neutral', personal: null,
            sourceClanId: clans[a.id] || 0, targetClanId: clans[b.id] || 0 }) };
        const input = (standing, arriving = unit(1, 'd'), extra = {}) => ({ spot, npcId: NPC, arriving, standing, untargeted: 0,
            at: 1000, step: 7, memory, personaFor: () => ({ traits: { caution: 0.5 } }), capacityForSpot: () => 4, ...extra });
        const raised = key => Situations.counts().raised[key] || 0;
        const solos = (...ids) => ids.map(id => unit(id));
        // Room 4, half of it this species: two places.
        assert.equal(Contest.targetPressure(spot, NPC, 3, 2, () => 4).pressure, 2, 'hunters on the species and a spawn share of the untargeted');
        assert.equal(Contest.contest(input(solos(2))).action, 'coexist', 'two hunters on two places: no contest');
        assert.equal(Contest.contest(input([unit(2), unit(3, 'none', { npcId: NPC + 1 })])).action, 'coexist', 'a unit on another species is no rival');
        // A D-grade solo over two no-grade solos (1.5x): it stays, the weakest goes.
        const displacedCount = raised('spot:contest:stronger');
        const held = Contest.contest(input(solos(2, 3)));
        assert.deepEqual([held.action, held.reason, held.displaced], ['stay', 'stronger', [2]], 'the stronger arrival stays and displaces one down to room');
        assert.equal(raised('spot:contest:stronger'), displacedCount + 1, 'counted');
        assert.deepEqual(Contest.contest(input(solos(2, 3, 4, 5))).displaced, [2, 3, 4], 'at 2.5x it displaces the weakest down to room');
        assert.deepEqual(Contest.contest(input([unit(2, 'none', { partyId: 'standing-party' }), unit(3)])).displaced, [3],
            'a standing party is never displaced');
        assert.deepEqual(Contest.contest(input([unit(2, 'none', { partyId: 'standing-party', hunters: 2 })])).action, 'avoid',
            'with only a standing party to displace it leaves');
        // A no-grade solo where a D-grade stranger stands: it leaves, outmatched.
        const outmatched = Contest.contest(input([unit(2, 'd'), unit(3)], unit(1)));
        assert.deepEqual([outmatched.action, outmatched.reason, outmatched.spotId], ['avoid', 'outmatched', 'pure-spot']);
        unloaded = new Set([2]);
        assert.equal(Contest.contest(input([unit(2, 'd'), unit(3)], unit(1, 'c'))).action, 'stay', 'a weaker unit unread is no obstacle');
        assert.equal(Contest.contest(input([unit(2, 'c'), unit(3)], unit(1))).reason, 'outmatched', 'a stronger unit unread counts as a stranger');
        unloaded = new Set();
        // Even (all no grade): the first come holds, at 1.5x and at 2.5x alike; with every roll
        // forced to the old offer_party or yield it still leaves.
        const even = Contest.contest(input(solos(2, 3), unit(1)));
        assert.deepEqual([even.action, even.reason], ['avoid', 'even'], 'an even arrival over room leaves');
        assert.deepEqual([Contest.contest(input(solos(2, 3, 4, 5), unit(1))).action, Contest.contest(input(solos(2, 3, 4, 5), unit(1))).reason],
            ['avoid', 'crowded'], 'at twice the room or more: crowded');
        // Clanmates share under twice the room.
        clans = { 1: 7, 2: 7 };
        assert.deepEqual([Contest.contest(input(solos(2, 3), unit(1))).action, Contest.contest(input(solos(2, 3), unit(1))).reason],
            ['stay', 'friendly_share'], 'a clanmate standing there: it shares at 1.5x');
        assert.equal(Contest.contest(input(solos(2, 3, 4, 5), unit(1))).reason, 'crowded', 'not at 2.5x');
        assert.equal(Contest.contest(input([unit(2, 'd'), unit(3)], unit(1))).reason, 'friendly_share', 'a stronger clanmate does not turn it away');
        clans = {};
        // A PvP dispute (a contest with PvP intent) keeps it there only with PvP on. A level gap
        // keeps grouping out: the first roll decides a retreat, the next a contest, the last the intent.
        Tendency.roll = (kind, key, i) => kind === 'spot_contest_decision' ? (i === 0 ? 0.99 : 0) : 0;
        const rivals = [unit(2, 'none', { level: 30 }), unit(3, 'none', { level: 30 }), unit(4, 'none', { level: 30 }), unit(5, 'none', { level: 30 })];
        assert.equal(Contest.contest(input(rivals, unit(1))).reason, 'crowded', 'PvP off: no dispute, it leaves');
        const pvp = Contest.contest(input(rivals, unit(1), { pvp: true }));
        assert.deepEqual([pvp.action, pvp.reason, pvp.event.action, pvp.event.pvpIntent, pvp.event.spotId], ['stay', 'pvp', 'contest', true, 'pure-spot'],
            'PvP on: the dispute goes to main and the arrival stays');
        Tendency.roll = () => 0;
        // One who holds its ground stays (counted).
        const commanded = raised('spot:contest:commanded');
        assert.equal(Contest.contest(input([unit(2, 'd'), unit(3)], unit(1, 'none', { holds: 'commanded' }))).action, 'stay',
            'a unit on a player\'s command never avoids');
        assert.equal(raised('spot:contest:commanded'), commanded + 1, 'counted');
        assert.equal(Contest.contest(input(solos(2, 3), unit(1, 'none', { holds: 'evacuation' }))).reason, 'evacuation', 'nor does a safety evacuation');
        // Bodies near a player are neither met nor displaced: a stronger arrival with only them there leaves.
        const hot = raised('spot:contest:hot_peer');
        assert.deepEqual(Contest.contest(input([unit(2, 'none', { hot: true }), unit(3, 'none', { hot: true })])).reason, 'even',
            'bodies near a player are not displaced');
        assert.equal(raised('spot:contest:hot_peer'), hot + 2);
        // More stronger units than are met: it leaves, counted.
        const capped = raised('spot:contest:capped');
        assert.equal(Contest.contest(input([2, 3, 4, 5, 6].map(id => unit(id, 'c')))).reason, 'outmatched');
        assert.equal(raised('spot:contest:capped'), capped + 1, 'more than four stronger units: counted');
    } finally { Tendency.roll = roll; }
}
// The outbox's way to main (SpotContestOutbox): an arrival's outcome after its step's own
// ack, fenced with the committed revision, in the next frame; an expired frame is counted.
{
    const { SpotContestOutbox } = require('../src/GameServer/Bot/Population/SpotContestOutbox');
    const Situations = invoke('GameServer/Bot/Situations');
    const raised = key => Situations.counts().raised[key] || 0;
    const at = Date.now();
    const outbox = new SpotContestOutbox({ stateOf: () => ({ phase: 'cold', simulation: { revision: 9 } }), partyOf: () => null,
        memoryRevision: () => 4 });
    const event = { key: 'spot_contest:k', at, action: 'contest', actor: { id: 1, revision: 1 }, peer: { id: 2, revision: 5 } };
    outbox.add(1, 'p1', event);
    assert.equal(outbox.reviewBatch(at), null, 'nothing goes before the ack');
    const stale = raised('spot:contest:stale');
    outbox.add(3, 'p3', { ...event, actor: { id: 3 } });
    outbox.acked([{ characterId: 3, ok: true, proposalId: 'other' }]);
    assert.equal(raised('spot:contest:stale'), stale + 1, 'another step\'s ack drops it, counted');
    assert(outbox.acked([{ characterId: 1, ok: true, proposalId: 'p1' }]));
    const frame = outbox.reviewBatch(at + 1);
    assert.deepEqual([frame.events.length, frame.events[0].at, frame.events[0].actor.revision, frame.events[0].peer.revision],
        [1, at + 1, 9, 5], 'the arriving side fenced at its commit, stamped at the frame');
    assert.equal(outbox.reviewBatch(at + 2), frame, 'one frame at a time, until its receipt');
    const expired = raised('spot:contest:expired');
    assert(outbox.receipt({ frameId: frame.frameId, at: frame.at, status: 'expired' }));
    assert.equal(raised('spot:contest:expired'), expired + 1, 'a lost frame is counted, not resent');
    assert.equal(outbox.snapshot(), null);
    // An arrival in flight stands on its spot until its ack, the units it displaces gone; a
    // heartbeat's sweep keeps it while fresh; its ack tells the displaced ones.
    const told = [];
    const arrivals = new SpotContestOutbox({ stateOf: () => ({ phase: 'cold', simulation: { revision: 9 } }), partyOf: () => null,
        memoryRevision: () => 4, displace: (id, spotId, by) => told.push([id, spotId, by]) });
    arrivals.arrive(1, 'p1', { spotId: 's', at, unit: { key: 'solo:1' }, displaced: [7] });
    arrivals.sweep(at + 1000);
    const flying = arrivals.pendingOn('s');
    assert.deepEqual([flying.units.map(unit => unit.key), [...flying.displaced]], [['solo:1'], [7]]);
    assert.equal(arrivals.pendingOn('other').units.length, 0);
    arrivals.acked([{ characterId: 1, ok: true, proposalId: 'p1' }], at + 1000);
    assert.deepEqual([told, arrivals.pendingOn('s').units.length], [[[7, 's', 1]], 0]);
    const refusedAt = raised('spot:contest:arrival_refused');
    arrivals.arrive(2, 'p2', { spotId: 's', at, unit: { key: 'solo:2' }, displaced: [8, 9] });
    arrivals.acked([{ characterId: 2, ok: false, proposalId: 'p2' }], at + 1000);
    assert.deepEqual([told.length, raised('spot:contest:arrival_refused') - refusedAt], [1, 2], 'a refused arrival displaces no one, counted per unit');
}

(async () => {
    const epoch = 'native:room-at-arrival', messages = [];
    let fault;
    const worker = new Worker(wrapper, { eval: true, workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch,
        workerPath: root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js', observer } });
    try {
        worker.on('message', message => messages.push(message));
        worker.on('error', error => { fault = error; });
        const wait = async predicate => {
            const deadline = Date.now() + 60000;
            while (!messages.some(predicate)) {
                if (fault) throw fault;
                const rejected = messages.find(message => message.type === 'fault');
                if (rejected) throw Error(JSON.stringify(rejected));
                if (Date.now() > deadline) throw Error('room at arrival worker timeout');
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            return messages.find(predicate);
        };
        const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
        let probes = 0;
        const probe = async input => {
            const msgId = `probe-${++probes}`;
            worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, msgId), probe: input });
            const response = await wait(message => message.probeId === msgId);
            if (response.error) throw Error(response.error);
            return response.value;
        };
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('catalog_page', { catalog: 'spots', rows: [room, away] });
        send('init', { config: { loopIntervalMs: 1000 }, recomputeGeneration: { code: 'a'.repeat(40), config: 'b'.repeat(64) } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running');
        send('pause', {}, 'pause');
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: [], removed: [], last: true },
            { name: 'market', from: null, to: 0, full: true, rows: [], removed: [], last: true },
            { name: 'personal_warehouse', from: null, to: 0, full: true, rows: [], removed: [], last: true }] });
        const standing = id => bot(id, { spotId: room.id, currentRegion: room.name, loc: { ...room.center } });
        // On its way to the spot: indexed there, not standing there.
        const onTheWay = bot(103, { activity: 'traveling', stats: { ...bot(103).stats,
            travel: { spotId: room.id, reason: 'level_replan', to: { ...room.center }, arrivalAt: Date.now() + 600000 } } });
        const rows = [standing(101), standing(102), onTheWay, bot(104), bot(105), bot(110), bot(111)];
        send('snapshot_page', { rows: rows.map(state => ({ state })), ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');

        // Two bots stand on a spot of two places: one more on the same species is over room.
        const over = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan' });
        assert(over.arrived, 'the bot arrives and stands on the spot');
        assert.equal(over.seen.pressure, 1.5, 'per-target pressure: three hunters on the species against its two places');
        assert.deepEqual(over.seen.standing, ['solo:101', 'solo:102'], 'the units standing there, not the one on its way');
        assert.equal(over.seen.npcId, NPC);
        assert.equal(over.seen.holds, null);
        assert.deepEqual([over.seen.action, over.seen.reason, over.marks, over.woken, over.standingAfter], ['avoid', 'even', [`${room.id}:contest_lost`], true, null],
            'an even arrival leaves: the spot marked, its earning spot woken, and it does not stand there');
        const packed = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'crowded' });
        assert.deepEqual([packed.marks, packed.woken, packed.outbox], [[`${room.id}:contest_lost`], true, null],
            'a spot found crowded marks it and wakes the earning spot, sending nothing to the standing units');
        const offered = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'pvp', keep: true });
        assert.equal(offered.changed, false, 'a PvP dispute leaves the arriving step as it is');
        assert.equal(offered.outbox, 'contest', 'and waits for the arriving commit\'s ack');
        assert.deepEqual(await probe({ kind: 'ack', id: 104, ok: true, reason: offered.proposalId }),
            { before: true, after: false, sent: ['contest'], stale: 0, unsent: 0, arrival_refused: 0 },
            'the arriving step\'s own ack sends it in the next frame');
        const refused = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'pvp', keep: true });
        assert.deepEqual(await probe({ kind: 'ack', id: 104, ok: false, reason: refused.proposalId }),
            { before: true, after: false, sent: [], stale: 0, unsent: 0, arrival_refused: 1 },
            'a refused arriving commit drops it: the arrival did not happen');
        const again = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'pvp', keep: true });
        assert.deepEqual(await probe({ kind: 'ack', id: 104, ok: true, reason: `${again.proposalId}:other` }),
            { before: true, after: false, sent: [], stale: 1, unsent: 0, arrival_refused: 0 },
            'an ack of another step drops it as stale, never re-fenced');
        const evacuating = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'unsafe_ground_evacuation' });
        assert.deepEqual([evacuating.seen.holds, evacuating.marks], ['evacuation', []], 'a safety evacuation holds its new ground: it never avoids');
        const coexist = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'coexist' });
        assert.equal(coexist.changed, false, 'coexist changes nothing');

        // A D-grade bot arrives over the two no-grade bots: it stays and displaces the weakest
        // down to room, once its commit is acked; until then it stands there and the displaced
        // one does not, so a second arrival in the same round trip meets it (and leaves).
        const dGrade = { 1: { selfId: 1, rank: 'd', equippedSlots: [7], amount: 1 }, 2: { selfId: 2, rank: 'd', equippedSlots: [10], amount: 1 } };
        await probe({ kind: 'memory', remove: [101, 102, 104, 105] });
        // A bot on a player's command is displaced like any weaker stranger: the player is told
        // who pushed it out, and its next step ends the command, so it goes elsewhere.
        await probe({ kind: 'command', id: 101, spotId: room.id, by: 9001 });
        const commandLost = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', inventory: dGrade, keep: true });
        assert.deepEqual([commandLost.seen.action, commandLost.displaced], ['stay', [101]], 'the commanded bot is displaced');
        await probe({ kind: 'ack', id: 104, ok: true, reason: commandLost.proposalId });
        const told = await wait(message => message.type === 'spot_command' && message.payload.commands[0].kind === 'command_lost');
        assert.deepEqual(told.payload.commands, [{ kind: 'command_lost', botId: 101, botName: 'Room101', playerId: 9001,
            spotName: room.name, holder: 'Room104' }], 'its player is told who pushed it out');
        assert(Protocol.validateEnvelope({ ...told, version: Protocol.PROTOCOL_VERSION }, 'worker', { workerEpoch: epoch }).ok, 'a message main accepts');
        // The player meets it (a hot period) and orders the same spot again before its next step:
        // the displacement it has not heard yet predates the order, which stands.
        await probe({ kind: 'command', id: 101, spotId: room.id, by: 9001, at: (await probe({ kind: 'wake', id: 101 })).at + 1 });
        assert.deepEqual(await probe({ kind: 'step', id: 101, keep: true }), { commanded: true, woken: true, ended: 0, next: room.id },
            'an order given after the displacement survives its step');
        await probe({ kind: 'command', id: 101, spotId: room.id, by: 9001 });
        // (The marked spot is refused; with nothing else here it waits for its woken earning decision.)
        assert.deepEqual(await probe({ kind: 'step', id: 101 }), { commanded: false, woken: true, ended: 1, next: null },
            'its next step ends the command (counted), wakes its earning spot and no longer goes to the spot it lost');
        await probe({ kind: 'command', id: 101 });
        const refusedHold = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', inventory: dGrade, keep: true });
        assert.deepEqual([refusedHold.seen.action, refusedHold.seen.reason, refusedHold.displaced.length], ['stay', 'stronger', 1]);
        await probe({ kind: 'ack', id: 104, ok: false, reason: refusedHold.proposalId });
        assert.equal(await probe({ kind: 'wake', id: refusedHold.displaced[0] }), null, 'a refused arriving commit displaces no one');
        const holder = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', inventory: dGrade, keep: true });
        assert.deepEqual([holder.seen.action, holder.marks, holder.standingAfter], ['stay', [], 'solo:104'], 'the stronger arrival stays');
        const [gone] = holder.displaced, kept = gone === 101 ? 102 : 101;
        const second = await probe({ kind: 'solo', id: 105, spotId: room.id, reason: 'level_replan' });
        assert.deepEqual(second.seen.standing, [`solo:${kept}`, 'solo:104'], 'an arrival in flight stands there, the bot it displaces does not');
        assert.equal(second.seen.reason, 'outmatched', 'and a weaker second arrival leaves');
        assert.deepEqual(await probe({ kind: 'ack', id: 104, ok: true, reason: holder.proposalId }),
            { before: true, after: false, sent: [], stale: 0, unsent: 0, arrival_refused: 0 });
        const wake = await probe({ kind: 'wake', id: gone });
        assert.deepEqual({ ...wake, at: wake?.at > 0 }, { spotId: room.id, reason: 'displaced', by: 104, at: true },
            'at the ack the displaced bot hears contest_lost at its next step');
        assert.equal(await probe({ kind: 'wake', id: kept }), null, 'the other keeps its spot');
        const after = await probe({ kind: 'solo', id: 105, spotId: room.id, reason: 'level_replan' });
        assert(!after.seen.standing.includes(`solo:${gone}`), 'until its next step, the displaced bot no longer counts there');
        // An arrival in flight that a later one displaced no longer stands there for a third.
        await probe({ kind: 'flight', spotId: room.id, party: [[110, []], [111, [110]]] });
        const third = await probe({ kind: 'solo', id: 105, spotId: room.id, reason: 'level_replan' });
        assert.deepEqual(third.seen.standing, [`solo:${kept}`, 'solo:111'], 'the displaced arrival in flight is gone');
        await probe({ kind: 'flight', spotId: room.id, party: [[110], [111]], clear: true });

        // One bot stands there and one is on its way: two hunters on two places is no contest.
        const free = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', remove: [gone], outcome: 'outmatched' });
        assert.equal(free.seen.pressure, 1, 'a bot on its way to the spot does not count against it');
        assert.equal(free.changed, false, 'an arrival into room meets no one');

        // A party of two arrives where one bot stands: over room, met as one unit through its leader.
        const party = { partyId: 'room-party', leaderId: 110, memberIds: [110, 111], spotId: room.id, stats: {} };
        const avoided = await probe({ kind: 'party', spotId: room.id, party, outcome: 'outmatched' });
        assert.equal(avoided.seen.arriving, 'room-party', 'a party is met as a whole');
        assert.equal(avoided.seen.pressure, 1.5);
        assert(avoided.excluded.includes(room.id), 'the party\'s next spot search skips the spot it lost');
        assert(avoided.lapsed.includes(room.id), 'the party\'s next spot answer keeps the mark: no return to the packed spot');
        assert.deepEqual(avoided.leaderMarks, [`${room.id}:contest_lost`], 'the leader lost the contest');
        assert.deepEqual(avoided.memberMarks, [], 'a member\'s own arrival is not met');
        assert.equal((await probe({ kind: 'party', spotId: room.id, party, outcome: 'pvp' })).outbox, true,
            'a PvP dispute with a standing unit waits for the leader\'s commit');
        const goal = { ...party, stats: { objective: { status: 'open', spotId: room.id } } };
        assert.deepEqual(await probe({ kind: 'party', spotId: room.id, party: goal, outcome: 'outmatched' }), { out: null, seen: null, outbox: false },
            'the party\'s own objective spot admits it: a full roster does not bounce off its goal');
        const fits = await probe({ kind: 'party', spotId: room.id, party, remove: [kept], outcome: 'outmatched' });
        assert.equal(fits.out, null, 'a party that fits the spot meets no one');
        assert.equal(fits.seen.pressure, 1);

        // Two near bots (run on main) move onto the spot: the spot assignment
        // posts their body facts (BotLifeState.notifyNearFacts) and the next
        // snapshot page brings them into the worker's index, where they count
        // at arrival.
        const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        const pages = [];
        Object.assign(coordinator, { workerEpoch: epoch, ready: true, started: true,
            worker: { postMessage: message => {
                if (message.type === 'snapshot_page') pages.push(message.payload);
                worker.postMessage(message);
            } } });
        const Actor = invoke('GameServer/Actor/Actor'), SpotService = invoke('GameServer/Bot/AI/SpotService');
        const template = utils.crushOb(invoke('GameServer/DataCache').classTemplates.find(row => Number(row.classId) === 0));
        const moveTo = (session, spot) => {
            session.actor.setLocXYZ({ ...spot.center });
            SpotService.assignSpot(session, { ...spot, npcNames: [] });
        };
        const near = (characterId, spot) => {
            LifeState.acceptClanCraftState({ characterId, characterName: `Near${characterId}`,
                phase: 'hot', activity: 'hunting', level: 20, spotId: spot.id, currentRegion: spot.name,
                locX: spot.center.locX, locY: spot.center.locY, locZ: spot.center.locZ, statsJson: '{}', updatedAt: Date.now() });
            const session = { accountId: `bot_room_${characterId}`, plan: 'hunting',
                dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
            session.actor = new Actor(session, { ...template, id: characterId, name: `Near${characterId}`, level: 20,
                ...spot.center, items: [], paperdoll: utils.tupleAlloc(16, {}) });
            moveTo(session, spot);
            return session;
        };
        const nearBots = [near(120, away), near(121, away)];
        await new Promise(resolve => setImmediate(resolve));
        await coordinator.sendSnapshots();
        await coordinator.criticalSnapshotInFlight;
        pages.length = 0;
        coordinator.snapshotBootstrapPending = false;
        // A spot move is posted at once (near_spot, critical), in a page of its own.
        nearBots.forEach(session => moveTo(session, room));
        await new Promise(resolve => setImmediate(resolve));
        await coordinator.criticalSnapshotInFlight;
        await coordinator.sendSnapshots();
        assert(pages.length && pages.every(page => page.initial !== true), 'the move goes in a dirty page, not a full snapshot');
        let standingNear = 0;
        for (const deadline = Date.now() + 5000; Date.now() < deadline && standingNear !== 2;) {
            standingNear = await probe({ kind: 'standing', spotId: room.id });
        }
        assert.equal(standingNear, 2, 'a near bot\'s spot change reaches the worker\'s index');
        const nearOver = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan' });
        assert.deepEqual(nearOver.seen.standing, ['solo:120', 'solo:121'], 'near bots standing there count');
        assert.equal(nearOver.seen.hot, 2, 'and are met by their own tactics near the player, not by the contest');
        console.log('Spot contest at arrival checks passed');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => process.exit());
