const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');

require('../src/Global');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

// The cold worker plans every solo resolve (planLifecycle) and decides there
// whether a bot waits for a party and which spot it hunts meanwhile. The plan
// and the party request are fixed per bot below; the spot rules run as they
// do in the worker. The resolved base state shows the decision.

const level = 30;
const field = (id, gx, gy, density) => ({
    id, name: `Field ${id}`,
    center: { locX: gx * 6000 + 3000, locY: gy * 6000 + 3000, locZ: -3000 },
    minLevel: level - 2, maxLevel: level + 2, avgLevel: level, density,
    levelCounts: { [level - 2]: Math.floor(density / 3), [level]: density - 2 * Math.floor(density / 3),
        [level + 2]: Math.floor(density / 3) },
    npcSelfIds: [], npcEntries: [], mob: { hp: 1, damage: 1 },
    rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 }
});
const current = field('20_20', 20, 20, 12);
const other = field('22_20', 22, 20, 12);
const denser = field('24_20', 24, 20, 40);
const spots = [current, other, denser];

const partyPlan = { status: 'active', strategy: 'farm', partyNeed: 'required', requiresParty: true,
    target: { selfId: 88 }, next: { spotId: 'party_only', npcId: 77, itemId: 88 } };
const soloPlan = { ...partyPlan, partyNeed: 'solo_ok', requiresParty: false };
const request = { status: 'open', priority: 'required', objectiveKey: 'farm:party_only:77', spotId: 'party_only',
    npcId: 77, itemId: 88, targetId: 88, requestedAt: Date.now(), attempts: 0 };
const scenarios = {
    101: { plan: partyPlan, request, planned: { spotId: other.id, npcId: 321 } },
    102: { plan: partyPlan, request, planned: { spotId: other.id, npcId: 321 }, resting: true },
    103: { plan: partyPlan, request: null, planned: { spotId: other.id, npcId: 321 } },
    104: { plan: partyPlan, request, planned: null },
    105: { plan: soloPlan, request, planned: { spotId: other.id, npcId: 321 } }
};

const probeSource = `
const { workerData } = require('worker_threads');
require(workerData.workerPath);
const scenario = (state) => workerData.scenarios[String(state.characterId)] || {};
invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan = (state) => ({
    acquisitionPlan: scenario(state).plan, replanContext: {}, reusablePartyRequest: false, excludedSpotIds: new Set()
});
invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan = (state) => scenario(state).request || null;
invoke('GameServer/Bot/AI/GearAcquisitionPlanner').safeFallbackForPlan = (state) => scenario(state).planned || null;
`;

(async () => {
    const epoch = 'party-wait-test';
    const worker = new Worker(probeSource, {
        eval: true,
        workerData: {
            workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
            workerEpoch: epoch,
            scenarios
        }
    });
    const received = [];
    let workerError;
    worker.on('error', (error) => { workerError = error; });
    worker.on('message', (message) => received.push(message));
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, epoch, payload));
    const until = async (predicate, label) => {
        const deadline = Date.now() + 20000;
        while (!received.some(predicate)) {
            if (workerError) throw workerError;
            if (Date.now() >= deadline) throw Error(`${label} timeout: ${JSON.stringify(received.map((m) => m.type))}`);
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return received.find(predicate);
    };
    try {
        await until((m) => m.type === 'ready' && m.payload.phase === 'loaded', 'load');
        send('catalog_page', { catalog: 'spots', rows: spots, done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('init', { config: { loopIntervalMs: 10 } });
        await until((m) => m.type === 'ready' && m.payload.phase === 'running', 'init');
        const now = Date.now();
        const rows = Object.entries(scenarios).map(([id, scenario]) => ({
            state: {
                characterId: Number(id), name: `Waiter${id}`, accountName: `bot_${id}`, level,
                phase: 'cold', activity: scenario.resting ? 'resting' : 'hunting',
                spotId: current.id, currentRegion: current.name, loc: { ...current.center },
                inventory: {}, adena: 1000,
                vitals: scenario.resting
                    ? { hp: 300, maxHp: 2000, mp: 100, maxMp: 1000 }
                    : { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
                timing: { lastResolvedAt: now - 45000, nextResolveAt: now - 1 },
                stats: { generatedCold: true, classId: 0, role: 'dps', equipment: [],
                    ...(scenario.resting ? { restUntil: now + 60000 } : {}) }
            },
            context: { spot: current, route: null }
        }));
        send('snapshot_page', { done: true, rows });
        const proposals = new Map();
        const granted = new Set();
        const deadline = Date.now() + 20000;
        while (Object.keys(scenarios).some((id) => !proposals.has(Number(id)))) {
            if (workerError) throw workerError;
            if (Date.now() >= deadline) throw Error(`proposals: ${JSON.stringify(received.map((m) => m.type))}`);
            for (const message of received.filter((m) => m.type === 'claim_request')) {
                const fresh = message.payload.candidates.filter((c) => !granted.has(c.characterId));
                fresh.forEach((c) => granted.add(c.characterId));
                if (fresh.length) {
                    send('claim_ack', { grants: fresh.map((c) => ({ ok: true, characterId: c.characterId,
                        ownerId: 'cold_simulation_owner', revision: c.expectedRevision + 1,
                        leaseId: `party-wait-${c.characterId}`, leaseUntil: Date.now() + 30000, purpose: c.purpose })) });
                }
            }
            for (const message of received.filter((m) => m.type === 'proposal_batch')) {
                for (const proposal of message.payload.proposals) proposals.set(Number(proposal.characterId), proposal);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert(!received.some((m) => m.type === 'fault'), JSON.stringify(received.filter((m) => m.type === 'fault')));
        // L9: the size the worker stamps on a proposal batch, taken from the
        // kernel's count, is the batch's real JSON size.
        for (const message of received.filter((m) => m.type === 'proposal_batch')) {
            const { bytes, ...sent } = message;
            assert.strictEqual(bytes, Protocol.byteLength(sent));
        }
        const planned = (id) => proposals.get(id).baseState;

        assert.strictEqual(planned(101).spotId, scenarios[101].planned.spotId,
            'a required waiter takes the safe fallback of its plan');
        assert.strictEqual(planned(101).activity, 'hunting');
        assert.strictEqual(planned(101).stats.partyRequest.priority, 'required');

        assert.strictEqual(planned(102).spotId, scenarios[102].planned.spotId);
        assert.strictEqual(planned(102).activity, 'resting', 'D3: a found fallback does not skip the rest');

        assert.strictEqual(planned(103).spotId, current.id, 'a party-only plan without a request does not wait');

        assert.strictEqual(planned(104).spotId, current.id,
            'U2: without a planned fallback the worker keeps its fitting current spot, as the coordinator does');

        assert.strictEqual(planned(105).spotId, scenarios[105].planned.spotId,
            'a required request waits even when the plan is solo-safe');
    } finally {
        await worker.terminate();
    }
    console.log('Cold worker party wait checks passed');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
