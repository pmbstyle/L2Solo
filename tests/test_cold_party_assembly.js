const assert = require('assert');
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
invoke('GameServer/DataCache').init();
const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const { ColdSimulationKernel, finishPartyRouteTravelState } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');
const at = 1800000000000;
const point = { locX: 145224, locY: 120001, locZ: -4500 };
const spot = { id: '24_20:antharas_lair', name: 'Assembly test', center: point,
    avgLevel: 20, minLevel: 20, maxLevel: 20, density: 3, npcSelfIds: [],
    mob: { hp: 1, damage: 1 }, rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 } };
const party = { partyId: 'assembly-party', leaderId: 1, memberIds: [1, 2], status: 'active',
    spotId: spot.id, nextResolveAt: at, cohesion: 1,
    stats: { fightsResolved: 10, sessionExpiresAt: at + 3600000 } };
const members = [1, 2].map(characterId => ({ characterId, name: `Hunter${characterId}`, level: 40, exp: 1000,
    phase: 'cold', activity: 'grouped', spotId: spot.id, loc: { ...point },
    party: { partyId: party.partyId, leaderId: 1, role: 'dps' },
    vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
    timing: { lastResolvedAt: at - 45000, nextResolveAt: at }, stats: { classId: 1, role: 'dps' } }));
const resolve = (roster, overrides = {}) => Resolver.resolve({ party, members: roster, spot,
    timestamp: at, elapsedMs: 45000, rng: () => 0.5, ...overrides });
const scattered = [members[0], { ...members[1], loc: { locX: 48000, locY: 210000, locZ: -3400 } }];
function assertWaiting(result) {
    assert.strictEqual(result.debug.reason, 'party_assembling');
    assert.strictEqual(result.debug.fights, 0);
    assert.strictEqual(result.nextResolveAt, at + 30000);
    assert.deepStrictEqual(result.events, []);
    assert.strictEqual(result.partyPatch.stats.lastResolveAt, at);
    assert.strictEqual(result.partyPatch.stats.fightsResolved, undefined);
    result.memberResults.forEach(({ result: member }) => {
        assert.deepStrictEqual(member.materialize, { exp: 0, sp: 0, adena: 0, items: [] });
        assert.deepStrictEqual(member.patch, {});
        assert.deepStrictEqual(member.memoryEvents, []);
        assert.strictEqual(member.nextResolveAt, at + 30000);
    });
}
async function main() {
    for (const [roster, overrides] of [
        [scattered, {}],
        [[members[0], { ...members[1], loc: { ...point, locX: point.locX + 3100 } }], {}],
        [[members[0], { ...members[1], loc: { ...point, locZ: 160 } }], {}],
        [[members[0], { ...members[1], loc: null }], {}],
        [members, { party: { ...party, spotId: 'elsewhere' } }],
        [[members[0], { ...members[1], activity: 'traveling', stats: { travel: { spotId: spot.id } } }], {}]
    ]) {
        const before = JSON.stringify(roster);
        assertWaiting(resolve(roster, { ...overrides, rng: () => { throw Error('assembly must precede combat'); } }));
        assert.strictEqual(JSON.stringify(roster), before);
    }
    const service = invoke('GameServer/Bot/AI/SpotService');
    const destinations = service.arrivalPointsForParty(members, { ...spot,
        arrivalPoints: [point, { ...point, locX: point.locX + 3100 }] });
    assert(destinations, 'a common arrival anchor is available');
    const assembled = members.map(member => ({ ...member, loc: destinations[member.characterId] }));
    assert(require('../src/GameServer/Bot/Population/PartyHuntingAssembly').ready(party, assembled, spot),
        'party destinations form a compact group on the correct dungeon floor');

    const raidSpot = { ...spot, id: 'raid:10131', raidBoss: true,
        arrivalPoints: [{ ...point, locX: point.locX + 650 }] };
    const remoteRaidParty = { ...party, spotId: raidSpot.id };
    const remoteRaidMembers = members.map(member => ({ ...member,
        loc: { ...member.loc, locX: member.loc.locX + 3000 } }));
    assert.strictEqual(require('../src/GameServer/Bot/Population/PartyHuntingAssembly')
        .ready(remoteRaidParty, remoteRaidMembers, raidSpot), false,
        'a raid party cannot fight remotely before reaching the boss');
    const raidDestinations = service.arrivalPointsForParty(members, raidSpot);
    const arrivedRaidMembers = members.map(member => ({ ...member,
        spotId: raidSpot.id, loc: raidDestinations[member.characterId] }));
    assert(require('../src/GameServer/Bot/Population/PartyHuntingAssembly')
        .ready(remoteRaidParty, arrivedRaidMembers, raidSpot),
        'a compact raid party at the boss may begin preparation');

    const understaffed = resolve(members, { party: { ...party, stats: { ...party.stats,
        objective: { clanGoalKey: 'clan:1', minPartySize: 3 } } },
        rng: () => { throw Error('understaffed clan party must not fight'); } });
    assert.strictEqual(understaffed.debug.reason, 'clan_party_understaffed');
    assert.strictEqual(understaffed.debug.fights, 0);

    const resting = scattered.map(s => ({ ...s, activity: 'resting',
        vitals: { ...s.vitals, hp: 100 }, stats: { ...s.stats, restUntil: at + 60000 } }));
    const recovery = resolve(resting);
    assert.strictEqual(recovery.debug.fights, 0);
    assert(recovery.memberResults.every(e => e.result.patch.vitals.hp > e.state.vitals.hp), 'assembly cannot block recovery');

    const messages = [];
    const kernel = new ColdSimulationKernel({ now: () => at,
        resolveSolo: () => { throw Error('party must not become solo combat'); },
        resolveParty: options => Resolver.resolve(options),
        emit: (type, payload) => messages.push({ type, payload }),
        // The round's exp lands on the projected state, as the worker's projection does.
        projectResolve: (state, result) => ({ ...state, ...result.patch, exp: state.exp + Number(result.materialize?.exp || 0) }) });
    for (const state of scattered) {
        kernel.upsert({ state });
        kernel.inFlight.set(state.characterId, { state, startedAt: at, partyId: party.partyId });
    }
    kernel.partyRuns.set(party.partyId, { party, members: scattered, spot, startedAt: at });
    await kernel.resolvePartyStep(party.partyId);
    const batch = messages.find(m => m.type === 'proposal_batch');
    assert(batch, JSON.stringify(messages));
    assert(batch.payload.proposals.every(p => p.nextState.exp === scattered.find(s => s.characterId === p.characterId).exp));
    assert.deepStrictEqual(batch.payload.proposals.map(p => p.nextState.loc), scattered.map(s => s.loc));
    assert.strictEqual(batch.payload.proposals.find(p => p.partyResolution).partyResolution.party.nextResolveAt, at + 30000);

    const route = { needed: true, reason: 'party_spot_replan', spotId: spot.id,
        travelMs: 25000, to: point, destinations: { 1: point, 2: point } };
    const travelling = scattered.map(s => beginHuntingTrip(s, route, at));
    assert.deepStrictEqual(travelling[1].loc, scattered[1].loc, 'departure does not teleport');
    // Without a shared party time each member runs its own way; all are there by the last arrival.
    const arrivedAt = Math.max(...travelling.map(s => s.stats.travel.arrivalAt));
    const arrived = travelling.map(s => finishPartyRouteTravelState(s, arrivedAt));
    const hunt = resolve(arrived, { timestamp: arrivedAt });
    assert(hunt.partyPatch.stats.partySpotRisk, 'actual party combat records a party-owned risk window');
    assert.strictEqual(hunt.partyPatch.stats.partySpotRisk.partyId, party.partyId);
    assert(hunt.debug.wins > 0 && hunt.memberResults.some(e => e.result.materialize.exp > 0), 'arrived party resumes ordinary combat');

    // Exercise the actual isolated worker: its static area catalog must reject
    // a surface teammate with the same X/Y sector and saved dungeon spot id.
    const { Worker } = require('worker_threads');
    const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
    const worker = new Worker(require.resolve('../src/GameServer/Bot/Population/ColdSimulationWorker'), {
        workerData: { workerEpoch: 'assembly-test', sharedGeodata: Geodata.sharedDescriptor() }
    });
    const received = [];
    let workerError;
    worker.on('error', error => { workerError = error; });
    worker.on('message', message => received.push(message));
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, 'assembly-test', payload, msgId));
    const until = async predicate => {
        const deadline = Date.now() + 15000;
        while (!received.some(predicate)) {
            if (workerError) throw workerError;
            if (Date.now() >= deadline) throw Error(`worker assembly timeout: ${JSON.stringify(received)}`);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return received.find(predicate);
    };
    try {
        await until(m => m.type === 'ready' && m.payload.phase === 'loaded');
        // The worker finds the party's spot in its spot catalog.
        send('catalog_page', { catalog: 'spots', rows: [spot], done: true });
        send('init', { config: { loopIntervalMs: 10 } });
        await until(m => m.type === 'ready' && m.payload.phase === 'running');
        const now = Date.now();
        const workerParty = { ...party, nextResolveAt: now - 1,
            stats: { sessionExpiresAt: now + 3600000 } };
        const workerMembers = members.map((s, index) => ({ ...s,
            loc: { ...point, locZ: index ? 160 : point.locZ },
            timing: { lastResolvedAt: now - 45000, nextResolveAt: now - 1 } }));
        // The party row comes from main's parties table, the members from their snapshot rows.
        send('table_page', { tables: [{ name: 'parties', from: null, to: 0, full: true,
            rows: [[workerParty.partyId, workerParty]], removed: [], last: true }] });
        send('snapshot_page', { done: true, rows: workerMembers.map(state => ({ state })) });
        const proposal = await until(m => m.type === 'proposal_batch');
        assert(proposal.payload.proposals.every(p => p.nextState.exp === workerMembers.find(s => s.characterId === p.characterId).exp));
        assert(proposal.payload.proposals.every(p => !p.result.memoryEvents?.length));
        assert(!received.some(m => m.type === 'fault'), JSON.stringify(received));
    } finally { await worker.terminate(); }
    console.log('Cold party assembly: no remote combat or rewards, recovery, worker wait, and travel resumption passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
