const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const { ColdSimulationKernel, beginRouteTravelState, finishPartyRouteTravelState } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const at = 1800000000000;
const point = { locX: 145224, locY: 120001, locZ: -4500 };
const spot = { id: '24_20:antharas_lair', name: 'Assembly test', center: point,
    avgLevel: 20, minLevel: 20, maxLevel: 20, density: 3, npcSelfIds: [],
    mob: { hp: 1, damage: 1 }, rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 } };
const party = { partyId: 'assembly-party', leaderId: 1, memberIds: [1, 2], status: 'active',
    spotId: spot.id, nextResolveAt: at, cohesion: 1,
    stats: { fightsResolved: 10, sessionExpiresAt: at + 3600000 } };
const members = [1, 2].map(characterId => ({ characterId, name: `Hunter${characterId}`, level: 40,
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
        [[members[0], { ...members[1], loc: { ...point, locZ: 160 } }], {}],
        [[members[0], { ...members[1], loc: null }], {}],
        [members, { party: { ...party, spotId: 'elsewhere' } }],
        [[members[0], { ...members[1], activity: 'traveling', stats: { travel: { spotId: spot.id } } }], {}]
    ]) {
        const before = JSON.stringify(roster);
        assertWaiting(resolve(roster, { ...overrides, rng: () => { throw Error('assembly must precede combat'); } }));
        assert.strictEqual(JSON.stringify(roster), before);
    }
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
        projectResolve: (state, result) => ({ ...state, ...result.patch }) });
    kernel.partyRuns.set(party.partyId, { party, members: scattered, spot, route: null,
        grants: new Map(scattered.map(s => [s.characterId, { characterId: s.characterId,
            leaseId: `assembly-${s.characterId}`, revision: 1 }])) });
    await kernel.resolvePartyGrant(party.partyId);
    const batch = messages.find(m => m.type === 'proposal_batch');
    assert(batch, JSON.stringify(messages));
    assert(batch.payload.proposals.every(p => p.result.materialize.exp === 0));
    assert.deepStrictEqual(batch.payload.proposals.map(p => p.nextState.loc), scattered.map(s => s.loc));
    assert.strictEqual(batch.payload.proposals.find(p => p.partyResolution).partyResolution.party.nextResolveAt, at + 30000);

    const route = { needed: true, reason: 'party_spot_replan', spotId: spot.id,
        travelMs: 25000, to: point, destinations: { 1: point, 2: point } };
    const travelling = scattered.map(s => beginRouteTravelState(s, route, at));
    assert.deepStrictEqual(travelling[1].loc, scattered[1].loc, 'departure does not teleport');
    const arrived = travelling.map(s => finishPartyRouteTravelState(s, at + 25000));
    const hunt = resolve(arrived, { timestamp: at + 25000 });
    assert(hunt.debug.wins > 0 && hunt.memberResults.some(e => e.result.materialize.exp > 0), 'arrived party resumes ordinary combat');

    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const Spots = invoke('GameServer/Bot/AI/SpotService');
    const restore = [];
    const patch = (object, key, value) => {
        const original = object[key]; restore.push(() => { object[key] = original; }); object[key] = value;
    };
    try {
        const saved = [];
        const occupancy = { [spot.id]: { count: 2, reservedCount: 2, capacity: 3,
            reservedKeys: new Set(['1', '9']), retained: new Set(['1', '9']) } };
        patch(Life, 'statesForParty', async () => scattered);
        patch(Life, 'upsertState', async state => { saved.push(state); return state; });
        patch(Parties, 'createOrUpdate', async next => next);
        patch(Profiles, 'findById', () => spot);
        patch(Profiles, 'ensure', () => [spot]);
        patch(Profiles, 'currentOccupancy', () => occupancy);
        patch(Spots, 'findCurrentSpot', () => spot);
        patch(Spots, 'arrivalPointForState', () => point);
        const legacy = await Population.resolveBackgroundParty({ ...party,
            stats: { ...party.stats, objective: { spotId: spot.id } } });
        assert.strictEqual(legacy.debug.activity, 'party_travel', 'legacy resolver also gathers distant followers when leader is already there');
        assert.strictEqual(saved.length, 2);
        assert.deepStrictEqual(saved[1].loc, scattered[1].loc);
        assert(saved.every(s => s.stats.travel.reason === 'party_spot_replan'));
        assert.strictEqual(occupancy[spot.id].reservedCount, 3);
    } finally { restore.reverse().forEach(fn => fn()); }

    // Exercise the actual isolated worker: its static area catalog must reject
    // a surface teammate with the same X/Y sector and saved dungeon spot id.
    const { Worker } = require('worker_threads');
    const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
    const worker = new Worker(require.resolve('../src/GameServer/Bot/Population/ColdSimulationWorker'), {
        workerData: { workerEpoch: 'assembly-test' }
    });
    const received = [];
    let workerError;
    worker.on('error', error => { workerError = error; });
    worker.on('message', message => received.push(message));
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, 'assembly-test', payload));
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
        send('init', { config: { loopIntervalMs: 10 } });
        await until(m => m.type === 'ready' && m.payload.phase === 'running');
        const now = Date.now();
        const workerParty = { ...party, nextResolveAt: now - 1,
            stats: { sessionExpiresAt: now + 3600000 } };
        const workerMembers = members.map((s, index) => ({ ...s,
            loc: { ...point, locZ: index ? 160 : point.locZ },
            timing: { lastResolvedAt: now - 45000, nextResolveAt: now - 1 } }));
        send('snapshot_page', { done: true, rows: workerMembers.map(state => ({ state,
            context: state.characterId === 1 ? { isPartyLeader: true, party: workerParty,
                partyMembers: workerMembers, spot, route: null } : {} })) });
        const claim = await until(m => m.type === 'claim_request');
        send('claim_ack', { grants: claim.payload.candidates.map(c => ({ ok: true, characterId: c.characterId,
            ownerId: 'cold_simulation_owner', revision: c.expectedRevision + 1,
            leaseId: `worker-assembly-${c.characterId}`, leaseUntil: Date.now() + 30000, purpose: c.purpose })) });
        const proposal = await until(m => m.type === 'proposal_batch');
        assert(proposal.payload.proposals.every(p => p.result.materialize.exp === 0));
        assert(proposal.payload.proposals.every(p => !p.result.memoryEvents?.length));
        assert(!received.some(m => m.type === 'fault'), JSON.stringify(received));
    } finally { await worker.terminate(); }
    console.log('Cold party assembly: no remote combat or rewards, recovery, worker wait, and travel resumption passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
