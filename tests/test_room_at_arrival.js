// The spot aggregate at an arrival (SpotContest, situations.md B9/B14): a far bot's
// trip ends on a spot, in the background thread, and meets the units standing there
// once, by per-target pressure (the hunters on its target species against that
// species' share of the room); bots still on their way do not count. Over room it
// contests at most four standing units: avoid marks the spot (contest_lost wakes the
// earning spot, the mark lasts the outing), yield waits, an outcome
// touching a standing unit waits for the arriving commit's ack; a party is met as a
// whole through its leader, except at its own objective spot; a unit that arrives on
// a player's command never avoids;
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
        npcId: input.npcId, holds: input.arriving.holds, arriving: input.arriving.key };
    const peer = input.standing.find(unit => !unit.hot);
    if (!forced || !(verdict.pressure > 1) || !peer) return verdict;
    // An avoid by crowding touches no standing unit: no event, the spot on the verdict.
    if (forced === 'crowded') return { action: 'avoid', reason: 'crowded', pressure: verdict.pressure, spotId: String(input.spot.id) };
    return { action: forced, pressure: verdict.pressure, peer, event: { at: input.at, key: 'forced:' + input.arriving.key,
        spotId: input.spot.id, npcId: input.npcId, actor: { id: input.arriving.id }, peer: { id: peer.id }, action: forced } };
};
const marksOf = stats => Risk.spotMarks(stats).map(mark => mark.spotId + ':' + mark.reason);
module.exports.probe = async ({ kind, id, spotId, reason, remove, party, outcome = null, ok = true }) => {
    for (const gone of remove || []) kernel.remove(gone);
    forced = outcome; seen = null;
    if (kind === 'standing') return kernel.occupancy.physicalCount(spotId, { standingOnly: true });
    if (kind === 'near') return { marks: marksOf(kernel.states.get(id)?.state.stats), seen };
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
        const queued = outbox.pending.has(party.leaderId);
        outbox.pending.delete(party.leaderId);
        if (!out) return { out: null, seen, outbox: queued };
        const answered = { ...out.party, stats: { ...out.party.stats, partySpot: { spotId: null, at: 1 } } };
        return { excluded: [...PartyRisk.excludedSpotIds(out.party)], lapsed: [...PartyRisk.excludedSpotIds(answered)],
            wait: out.party.stats.coldCompetition?.wait || null, leaderMarks: marksOf(out.members[0].stats),
            memberMarks: marksOf(out.members[1].stats), seen };
    }
    const { beginHuntingTrip } = require('./HuntingTravel');
    const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const entry = kernel.states.get(id), now = Date.now();
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
    const queued = outbox.pending.get(id)?.events[0].action || null;
    const proposalId = outbox.pending.get(id)?.proposalId || null;
    return { arrived: result.patch.activity === 'hunting' && result.patch.spotId === spotId, changed: !!contested,
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

// The contest's own rule, pure: no contest under room; over room the rolled peers
// are decided in order; a commanded unit never avoids (B14); at most four peers; a
// standing body near a player is skipped. Rolls forced to 0: a level gap of 10 makes
// grouping impossible, so the first roll decides a retreat: avoid.
invoke('GameServer/DataCache').init();
{
    const Contest = require('../src/GameServer/Bot/Population/SpotContest');
    const Situations = invoke('GameServer/Bot/Situations');
    const Tendency = require('../src/GameServer/Bot/AI/TendencyRoll'), roll = Tendency.roll;
    Tendency.roll = () => 0;
    try {
        const spot = { id: 'pure-spot', npcEntries: [{ selfId: NPC, count: 1 }, { selfId: NPC + 1, count: 1 }] };
        const state = (id, level) => ({ characterId: id, name: `P${id}`, level, stats: {}, simulation: { revision: 1 } });
        const unit = (id, level, extra = {}) => ({ key: `solo:${id}`, id, name: `P${id}`, partyId: null, size: 1, level, hunters: 1,
            members: [state(id, level)], state: state(id, level), npcId: NPC, hot: false, ...extra });
        const memory = { assess: () => ({ ready: true, revision: 1, disposition: 'neutral', personal: null }) };
        const input = (standing, arriving = unit(1, 30), untargeted = 0) => ({ spot, npcId: NPC, arriving, standing, untargeted,
            at: 1000, step: 7, memory, personaFor: () => ({ traits: { caution: 0.5 } }), ownSide: () => ({ look: { weapon: 0, glow: 0, body: 0 }, people: 1 }),
            capacityForSpot: () => 4 });
        const raised = key => Situations.counts().raised[key] || 0;
        // Room 4, half of it this species: two places.
        assert.equal(Contest.targetPressure(spot, NPC, 3, 2, () => 4).pressure, 2, 'hunters on the species and a spawn share of the untargeted');
        assert.equal(Contest.contest(input([unit(2, 20)])).action, 'coexist', 'two hunters on two places: no contest');
        assert.equal(Contest.contest(input([unit(2, 20), unit(3, 20, { npcId: NPC + 1 })])).action, 'coexist',
            'a unit on another species is no rival');
        const lost = Contest.contest(input([unit(2, 20), unit(3, 20)]));
        assert.equal(lost.action, 'avoid', 'over room, the arriving unit retreats');
        assert.equal(lost.event.spotId, 'pure-spot');
        const commanded = raised('spot:contest:commanded');
        assert.equal(Contest.contest(input([unit(2, 20), unit(3, 20)], unit(1, 30, { holds: 'commanded' }))).action, 'coexist',
            'a unit on a player\'s command never avoids');
        assert.equal(raised('spot:contest:commanded'), commanded + 2, 'counted per peer it would have avoided');
        assert.equal(Contest.contest(input([unit(2, 20), unit(3, 20)], unit(1, 30, { holds: 'evacuation' }))).action, 'coexist',
            'nor does a safety evacuation');
        const hot = raised('spot:contest:hot_peer');
        assert.equal(Contest.contest(input([unit(2, 20, { hot: true }), unit(3, 20, { hot: true })])).action, 'coexist',
            'bodies near a player are not met');
        assert.equal(raised('spot:contest:hot_peer'), hot + 2);
        const capped = raised('spot:contest:capped');
        Contest.contest(input([2, 3, 4, 5, 6, 7].map(id => unit(id, 20))));
        assert.equal(raised('spot:contest:capped'), capped + 1, 'more than four standing units: four are met, counted');
        // Twice the room (CROWDED): a contest the peers settle by letting it stay (yield, or none met) is an
        // avoid by crowding, touching no standing unit; under it a yield stays a yield; one who holds its
        // ground coexists; a contest stays a contest. Rolls past every chance: the peers yield.
        Tendency.roll = () => 0.99;
        const four = [2, 3, 4, 5].map(id => unit(id, 20));
        assert.equal(Contest.targetPressure(spot, NPC, 5, 0, () => 4).pressure, 2.5, 'fixture: four standing and one arriving');
        const crowd = raised('spot:contest:crowded');
        const packed = Contest.contest(input(four));
        assert.deepEqual([packed.action, packed.reason, packed.spotId, packed.event], ['avoid', 'crowded', 'pure-spot', undefined],
            'a crowded spot: the arriving unit leaves and marks it, no event for the standing units');
        assert.equal(raised('spot:contest:crowded'), crowd + 1, 'counted');
        assert.equal(Contest.contest(input(four.map(peer => ({ ...peer, hot: true })))).action, 'avoid', 'none met: crowded too');
        assert.equal(Contest.contest(input([unit(2, 20), unit(3, 20)])).action, 'yield', 'under twice the room: the yield stands');
        assert.equal(Contest.contest(input(four, unit(1, 30, { holds: 'commanded' }))).action, 'coexist', 'a commanded unit stays');
        Tendency.roll = (kind, key, i) => kind === 'spot_contest_decision' ? (i === 0 ? 0.99 : 0) : 0;
        assert.equal(Contest.contest(input(four)).action, 'contest', 'a contest stays a contest');
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
        const rows = [standing(101), standing(102), onTheWay, bot(104), bot(110), bot(111)];
        send('snapshot_page', { rows: rows.map(state => ({ state })), ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');

        // Two bots stand on a spot of two places: one more on the same species is over room.
        const over = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan' });
        assert(over.arrived, 'the bot arrives and stands on the spot');
        assert.equal(over.seen.pressure, 1.5, 'per-target pressure: three hunters on the species against its two places');
        assert.deepEqual(over.seen.standing, ['solo:101', 'solo:102'], 'the units standing there, not the one on its way');
        assert.equal(over.seen.npcId, NPC);
        assert.equal(over.seen.holds, null);
        const lost = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'avoid' });
        assert.deepEqual(lost.marks, [`${room.id}:contest_lost`], 'a lost contest marks the spot');
        assert.equal(lost.woken, true, 'and wakes the earning spot at once');
        const packed = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'crowded' });
        assert.deepEqual([packed.marks, packed.woken, packed.outbox], [[`${room.id}:contest_lost`], true, null],
            'a spot found crowded marks it and wakes the earning spot, sending nothing to the standing units');
        const yielded = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'yield' });
        assert.deepEqual(yielded.marks, [], 'a yield marks nothing');
        assert(yielded.wait && yielded.wait.until > yielded.wait.start, 'a yield waits on the spot');
        const offered = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'contest' });
        assert.equal(offered.changed, false, 'an outcome touching a standing unit leaves the arriving step as it is');
        assert.equal(offered.outbox, 'contest', 'and waits for the arriving commit\'s ack');
        assert.deepEqual(await probe({ kind: 'ack', id: 104, ok: true, reason: offered.proposalId }),
            { before: true, after: false, sent: ['contest'], stale: 0, unsent: 0, arrival_refused: 0 },
            'the arriving step\'s own ack sends it in the next frame');
        const refused = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'contest' });
        assert.deepEqual(await probe({ kind: 'ack', id: 104, ok: false, reason: refused.proposalId }),
            { before: true, after: false, sent: [], stale: 0, unsent: 0, arrival_refused: 1 },
            'a refused arriving commit drops it: the arrival did not happen');
        const again = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'contest' });
        assert.deepEqual(await probe({ kind: 'ack', id: 104, ok: true, reason: `${again.proposalId}:other` }),
            { before: true, after: false, sent: [], stale: 1, unsent: 0, arrival_refused: 0 },
            'an ack of another step drops it as stale, never re-fenced');
        const evacuating = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'unsafe_ground_evacuation' });
        assert.equal(evacuating.seen.holds, 'evacuation', 'a safety evacuation holds its new ground: it never avoids');
        const coexist = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', outcome: 'coexist' });
        assert.equal(coexist.changed, false, 'coexist changes nothing');

        // One bot stands there and one is on its way: two hunters on two places is no contest.
        const free = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', remove: [102], outcome: 'avoid' });
        assert.equal(free.seen.pressure, 1, 'a bot on its way to the spot does not count against it');
        assert.equal(free.changed, false, 'an arrival into room meets no one');

        // A party of two arrives where one bot stands: over room, met as one unit through its leader.
        const party = { partyId: 'room-party', leaderId: 110, memberIds: [110, 111], spotId: room.id, stats: {} };
        const avoided = await probe({ kind: 'party', spotId: room.id, party, outcome: 'avoid' });
        assert.equal(avoided.seen.arriving, 'room-party', 'a party is met as a whole');
        assert.equal(avoided.seen.pressure, 1.5);
        assert(avoided.excluded.includes(room.id), 'the party\'s next spot search skips the spot it lost');
        assert(avoided.lapsed.includes(room.id), 'the party\'s next spot answer keeps the mark: no return to the packed spot');
        assert.deepEqual(avoided.leaderMarks, [`${room.id}:contest_lost`], 'the leader lost the contest');
        assert.deepEqual(avoided.memberMarks, [], 'a member\'s own arrival is not met');
        const waiting = await probe({ kind: 'party', spotId: room.id, party, outcome: 'yield' });
        assert(waiting.wait, 'a yielding party waits');
        assert.equal((await probe({ kind: 'party', spotId: room.id, party, outcome: 'offer_party' })).outbox, true,
            'an offer to a standing unit waits for the leader\'s commit');
        const goal = { ...party, stats: { objective: { status: 'open', spotId: room.id } } };
        assert.deepEqual(await probe({ kind: 'party', spotId: room.id, party: goal, outcome: 'avoid' }), { out: null, seen: null, outbox: false },
            'the party\'s own objective spot admits it: a full roster does not bounce off its goal');
        const fits = await probe({ kind: 'party', spotId: room.id, party, remove: [101], outcome: 'avoid' });
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
