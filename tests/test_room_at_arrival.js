// The room at a spot is checked once, when a far bot's trip ends there, in the
// background thread, against the bots that stand on the spot (ARCH-08-a).
// A full spot leaves the bot standing there with a "was full" mark that its
// next step's spot search reads; bots still on their way do not count; a safety
// evacuation may exceed the spot by one bot; a party is checked as a whole,
// except at its own objective spot;
// a party run's spot search skips a spot with no room for the whole party;
// a near bot's spot assignment on main (its near fact post) reaches the worker's index and counts.
const assert = require('node:assert/strict');
const path = require('node:path');
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
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
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const bits = () => ({ occupation: Sections.sectionBit('occupation'), sources: Sections.sectionBit('sources') });
// The step's one raise (BotLifeState.prepareResolve): the sections its cheap
// check named, in the bump the step's own decision point then reads.
const Events = require('../AI/DecisionEvents'), raise = Events.raiseSections;
let raised = null;
Events.raiseSections = (before, after, ...lists) => {
    if (lists.length === 3) raised = [...lists[2]];
    return raise(before, after, ...lists);
};
module.exports.probe = async ({ kind, id, spotId, reason, remove, party }) => {
    for (const gone of remove || []) kernel.remove(gone);
    if (kind === 'standing') return kernel.occupancy.physicalCount(spotId, { standingOnly: true });
    if (kind === 'search') {
        // The step's solo trip searches (routeTrip): the room its search may read.
        const Spots = invoke('GameServer/Bot/Population/SpotProfiles'), find = Spots.findForState;
        let hasRoom = null;
        Spots.findForState = (state, options) => { hasRoom = options.hasRoom || null; return null; };
        try {
            const entry = kernel.states.get(id);
            entry.route = null;
            // The step's planned state: hunting on the other spot (as a wait
            // fallback plans it), while the index still holds the bot's own entry.
            routeTrip({ ...entry.state, activity: 'hunting', spotId: party, stats: { ...entry.state.stats, travel: null } },
                { spot: null }, null, Date.now());
            entry.route = null;
        } finally { Spots.findForState = find; }
        return hasRoom && { [spotId]: hasRoom(spotId), [party]: hasRoom(party) };
    }
    if (kind === 'partySearch') {
        // The party run's search (the kernel's partyRoute): the room its
        // search may read, for the whole party.
        const Spots = invoke('GameServer/Bot/Population/SpotProfiles'), find = Spots.findForState;
        let hasRoom = null;
        Spots.findForState = (state, options) => { hasRoom = options.hasRoom || null; return null; };
        try {
            const members = party.memberIds.map(member => kernel.states.get(member).state);
            kernel.partyRoute({ leader: members[0], party, members, spot: null, timestamp: Date.now() });
        } finally { Spots.findForState = find; }
        return hasRoom && hasRoom(spotId);
    }
    if (kind === 'party') {
        const members = party.memberIds.map(member => kernel.states.get(member).state);
        const out = kernel.partyArrival({ party, members, spotId });
        if (!out) return null;
        const dirty = out.members.map(member => Number(member.stats?.wishDirty || 0));
        const memory = out.party.stats.partySpotRisk;
        const afterRound = { ...out.party, stats: { ...out.party.stats,
            partySpotRisk: { ...memory, rounds: memory.rounds + 1 } } };
        return { excluded: [...PartyRisk.excludedSpotIds(out.party)], dirty, bits: bits(),
            rounds: [PartyRisk.rounds(party), PartyRisk.rounds(out.party)],
            lapsed: [...PartyRisk.excludedSpotIds(afterRound)] };
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
    raised = null;
    const projected = (await kernel.projectResolve(traveling, result, now)).state;
    const next = { ...projected, stats: { ...projected.stats, stepCount: Risk.stepCount(projected) + 1 } };
    return { activity: projected.activity, spotId: projected.spotId, before: Risk.stepCount(traveling),
        marks: projected.stats.capacityBackoffs || [], raised,
        seq: [Number(traveling.stats.decisionSeq || 0), Number(projected.stats.decisionSeq || 0)],
        excludedNow: [...Risk.excludedSpotIdsForStates([projected])],
        excludedAfter: [...Risk.excludedSpotIdsForStates([next])] };
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
    minLevel: 18, maxLevel: 24, avgLevel: 21, density: 12, capacity: 2, levelCounts: { 20: 6 } };
const away = { ...room, id: 'room-away', name: 'Away field', center: { locX: 20000, locY: -176000, locZ: -1000 }, capacity: 20 };

function bot(characterId, extra = {}) {
    const now = Date.now();
    return { characterId, name: `Room${characterId}`, accountName: `bot_room_${characterId}`, phase: 'cold',
        activity: 'hunting', level: 20, exp: 0, sp: 0, adena: 1000, currentRegion: away.name, spotId: away.id,
        loc: { ...away.center }, inventory: {}, vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
        stats: { classId: 0, classProgressionClassId: 0, classProgressionLevel: 20, generatedCold: true, stepCount: 7 },
        timing: { lastResolvedAt: now - 10000, nextResolveAt: now + 600000 }, ...extra };
}

(async () => {
    invoke('GameServer/DataCache').init();
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

        // Two bots stand on a spot of two places: the arriving bot finds it full.
        const full = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan' });
        assert.equal(full.activity, 'hunting', 'the bot arrives and stands on the full spot until its next step');
        assert.equal(full.spotId, room.id);
        assert.deepEqual(full.marks.map(mark => mark.spotId), [room.id], 'the full spot gets the "was full" mark');
        assert.equal(full.marks[0].untilStep, full.before + 1 + 1, 'the mark is counted from the step before its +1');
        assert.deepEqual(full.raised, ['occupation', 'sources'],
            'the full spot raises occupation and sources in the step\'s one bump');
        assert(full.seq[1] > full.seq[0], 'the raise moves the decision sequence');
        assert(full.excludedNow.includes(room.id), 'the next step\'s spot search skips the full spot');
        assert(!full.excludedAfter.includes(room.id), 'the mark lapses after that step');

        // A safety evacuation may exceed a full spot by one bot.
        const evacuation = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'unsafe_ground_evacuation' });
        assert.deepEqual(evacuation.marks, [], 'an evacuation takes the one overflow place');

        // One bot stands there and one is on its way: the arriving bot takes the free place.
        const free = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', remove: [102] });
        assert.deepEqual(free.marks, [], 'a bot on its way to the spot does not count against it');
        assert.deepEqual(free.raised, [], 'an arrival into room raises nothing');

        // ROUTE-ROOM: the step's spot search skips a spot with no room for
        // the bot, those on their way counted (one stands there, one comes).
        const search = id => probe({ kind: 'search', id, spotId: room.id, party: away.id });
        assert.deepEqual(await search(104), { [room.id]: false, [away.id]: true },
            'the search counts the bots on their way: no room left for one more');
        assert.deepEqual(await search(103), { [room.id]: true, [away.id]: true },
            'the bot\'s own index entry is not counted against it');

        // The party run's search skips a spot with no room for the whole
        // party: one stands there, one comes (101, 103), the spot holds two.
        const roaming = memberIds => ({ partyId: 'room-search', leaderId: memberIds[0], memberIds, spotId: away.id, stats: {} });
        const partySearch = (memberIds, remove) => probe({ kind: 'partySearch', spotId: room.id, party: roaming(memberIds), remove });
        assert.equal(await partySearch([110, 111]), false, 'a party of two finds no room where two bots are counted');
        assert.equal(await partySearch([101, 110], [103]), true,
            'the party\'s own member standing there is not counted against it: 0 + 2 fit');
        assert.equal(await partySearch([110, 111]), false, 'one bot stands there: no room for a party of two');
        assert.deepEqual(await search(104), { [room.id]: true, [away.id]: true }, 'a solo bot still takes the one free place');

        // A party of two arrives where one bot stands: no room for all its members.
        const party = { partyId: 'room-party', leaderId: 110, memberIds: [110, 111], spotId: room.id, stats: {} };
        const crowded = await probe({ kind: 'party', spotId: room.id, party });
        assert(crowded, 'a party is checked as a whole');
        assert.equal(crowded.rounds[1], crowded.rounds[0] + 1, 'the arrival counts as the party\'s step');
        assert(crowded.excluded.includes(room.id), 'the party\'s next spot search skips the full spot');
        assert(!crowded.lapsed.includes(room.id), 'the mark lapses after the party\'s next round');
        assert(crowded.dirty[0] & crowded.bits.occupation && crowded.dirty[0] & crowded.bits.sources,
            'the leader\'s next step reconsiders the spot');
        assert.equal(crowded.dirty[1], 0, 'a member\'s own arrival is not checked');
        const goal = { ...party, stats: { objective: { status: 'open', spotId: room.id } } };
        assert.equal(await probe({ kind: 'party', spotId: room.id, party: goal }), null,
            'the party\'s own objective spot admits it: a full roster does not bounce off its goal');
        assert.equal(await probe({ kind: 'party', spotId: room.id, party, remove: [101] }), null,
            'a party that fits the spot arrives without a mark');

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
        nearBots.forEach(session => moveTo(session, room));
        await new Promise(resolve => setImmediate(resolve));
        pages.length = 0;
        coordinator.snapshotBootstrapPending = false;
        await coordinator.sendSnapshots();
        assert(pages.length && pages.every(page => page.initial !== true), 'the move goes in a dirty page, not a full snapshot');
        let standingNear = 0;
        for (const deadline = Date.now() + 5000; Date.now() < deadline && standingNear !== 2;) {
            standingNear = await probe({ kind: 'standing', spotId: room.id });
        }
        assert.equal(standingNear, 2, 'a near bot\'s spot change reaches the worker\'s index');
        const nearFull = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan' });
        assert.deepEqual(nearFull.marks.map(mark => mark.spotId), [room.id], 'near bots standing there fill the spot');
        console.log('Room at arrival checks passed');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => process.exit());
