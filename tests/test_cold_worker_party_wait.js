const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');

require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

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
const marketPlan = { status: 'active', strategy: 'market', target: { selfId: 88 } };
const clanCall = { status: 'open', priority: 'required', clanGoalKey: 'clan-goal', clanId: 7,
    objectiveKey: 'clan:party_only', spotId: 'party_only', npcId: 77, requestedAt: Date.now() };
const request = { status: 'open', priority: 'required', objectiveKey: 'farm:party_only:77', spotId: 'party_only',
    npcId: 77, itemId: 88, targetId: 88, requestedAt: Date.now(), attempts: 0 };
const scenarios = {
    101: { plan: partyPlan, request, planned: { spotId: other.id, npcId: 321 } },
    102: { plan: partyPlan, request, planned: { spotId: other.id, npcId: 321 }, resting: true },
    103: { plan: partyPlan, request: null, planned: { spotId: other.id, npcId: 321 } },
    104: { plan: partyPlan, request, planned: null },
    105: { plan: soloPlan, request, planned: { spotId: other.id, npcId: 321 } },
    106: { plan: { ...soloPlan, inputPreparation: { recipeId: 447, target: { selfId: 148 } } },
        request: null, planned: null },
    // A waiter standing in town (on no catalogue spot) with no spot of its own.
    107: { plan: partyPlan, request, planned: { spotId: other.id, npcId: 321 }, town: true },
    // A waiter holding at a gathering point in town (party_wait: main's command owns it).
    108: { plan: partyPlan, request, planned: { spotId: other.id, npcId: 321 }, town: true, activity: 'party_wait' },
    // A waiter already on its planned fallback, its hunting leaf naming no spot it may take:
    // the route search alone names the fallback and its NPC.
    109: { plan: partyPlan, request, planned: { spotId: current.id, npcId: 321 }, leaf: { activity: 'hunting', spotId: 'nowhere' } },
    // A clan member called to a required clan hunt while it buys its gear on the market:
    // forming never takes it, so the call does not hold it.
    110: { plan: marketPlan, request: null, planned: null, clanCall: true },
    // A clan member already held waiting for the clan hunt when it turned to the market:
    // the call no longer holds it, it goes back to its hunt.
    111: { plan: marketPlan, request: null, planned: null, clanCall: true, activity: 'party_wait', heldWait: true }
};
const townLoc = { locX: 10 * 6000 + 3000, locY: 20 * 6000 + 3000, locZ: -3000 };

const probeSource = `
const { workerData } = require('worker_threads');
require(workerData.workerPath);
const scenario = (state) => workerData.scenarios[String(state.characterId)] || {};
invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan = (state) => ({
    acquisitionPlan: scenario(state).plan, replanContext: {}, reusablePartyRequest: false, excludedSpotIds: new Set(),
    economy: { statsPacket: {}, network: { queue: [], activity: scenario(state).leaf || { activity: scenario(state).resting ? 'resting' : 'hunting',
        ...(scenario(state).planned || {}) } }, riskWeight: 0, stock: () => null }
});
invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan = (state) => scenario(state).request || null;
invoke('GameServer/Bot/AI/GearAcquisitionPlanner').safeFallbackForPlan = (state) => scenario(state).planned || null;
invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan = (state) => state.characterId === 106
    ? { status: 'active', strategy: 'craft', recipeId: 362, target: { selfId: 2384 } } : null;
`;

(async () => {
    const epoch = 'party-wait-test';
    const worker = new Worker(probeSource, {
        eval: true,
        workerData: {
            workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
            workerEpoch: epoch,
            sharedGeodata: Geodata.sharedDescriptor(),
            scenarios
        }
    });
    const received = [];
    let workerError;
    worker.on('error', (error) => { workerError = error; });
    worker.on('message', (message) => received.push(message));
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
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
                phase: 'cold', activity: scenario.activity || (scenario.resting ? 'resting' : 'hunting'),
                spotId: scenario.town ? null : current.id, currentRegion: current.name,
                loc: scenario.town ? { ...townLoc } : { ...current.center },
                inventory: {}, adena: 1000,
                vitals: scenario.resting
                    ? { hp: 300, maxHp: 2000, mp: 100, maxMp: 1000 }
                    : { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
                timing: { lastResolvedAt: now - 45000, nextResolveAt: now - 1 },
                stats: { generatedCold: true, classId: 0, role: 'dps', equipment: [],
                    ...(scenario.resting ? { restUntil: now + 60000 } : {}),
                    ...(scenario.clanCall ? { clanId: 7, clanPartyObjective: clanCall, equipmentPlan: scenario.plan } : {}),
                    ...(scenario.heldWait ? { eventWait: 'clan_party_assembly', partyRequest: clanCall } : {}) }
            }
        }));
        send('snapshot_page', { done: true, rows });
        // A step the worker plans and resolves (a proposal), or main's command it plans (a
        // command request carrying the planned state).
        const proposals = new Map(), commands = new Map();
        const deadline = Date.now() + 20000;
        while (Object.keys(scenarios).some((id) => !proposals.has(Number(id)) && !commands.has(Number(id)))) {
            if (workerError) throw workerError;
            if (Date.now() >= deadline) throw Error(`proposals: ${JSON.stringify(received.map((m) => m.type))}`);
            for (const message of received.filter((m) => m.type === 'proposal_batch')) {
                for (const proposal of message.payload.proposals) proposals.set(Number(proposal.characterId), proposal);
            }
            for (const message of received.filter((m) => m.type === 'command_request')) {
                for (const request of message.payload.requests) commands.set(Number(request.characterId), request);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert(!received.some((m) => m.type === 'fault'), JSON.stringify(received.filter((m) => m.type === 'fault')));
        // The size the worker stamps on a proposal batch, taken from the
        // kernel's count, is the batch's real JSON size.
        for (const message of received.filter((m) => m.type === 'proposal_batch')) {
            const { bytes, ...sent } = message;
            assert.strictEqual(bytes, Protocol.byteLength(sent));
        }
        const planned = (id) => proposals.get(id).nextState;

        // A required waiter takes the safe fallback of its plan as its trip's destination:
        // the step that chose it starts the trip there, and its spotId stays where it
        // stands until it arrives (as every trip's).
        assert.strictEqual(planned(101).activity, 'traveling', 'the waiter leaves for its fallback in the same step');
        assert.strictEqual(planned(101).stats.travel?.spotId, scenarios[101].planned.spotId);
        assert.strictEqual(planned(101).spotId, current.id, 'a travelling waiter stands where it set out');
        assert.strictEqual(planned(101).stats.partyRequest.priority, 'required');

        assert.strictEqual(planned(102).spotId, current.id, 'a resting waiter rests where it stands');
        assert.strictEqual(planned(102).activity, 'resting', 'D3: a found fallback does not skip the rest');

        assert.strictEqual(planned(103).spotId, current.id, 'a party-only plan without a request does not wait');

        assert.strictEqual(planned(104).spotId, current.id,
            'U2: without a planned fallback the worker keeps its fitting current spot, as the coordinator does');

        assert.strictEqual(planned(105).stats.travel?.spotId, scenarios[105].planned.spotId,
            'a required request waits even when the plan is solo-safe');
        // A waiter in town travels to its fallback: it never hunts that spot from where it stands.
        assert.strictEqual(planned(107).activity, 'traveling', 'a waiter in town leaves for its fallback');
        assert.strictEqual(planned(107).stats.travel?.spotId, other.id);
        assert.notStrictEqual(planned(107).spotId, other.id, 'no spot is declared before the waiter arrives there');
        // Only its trip moves a waiter: one held by another owner is neither relabelled a
        // hunter nor sent off by its gear review.
        const held = commands.get(108)?.precomputedPlan?.plannedState;
        assert.strictEqual(held?.activity, 'party_wait', 'a waiter at its gathering point keeps waiting there');
        assert.strictEqual(held.stats.travel || null, null, 'no trip starts for a waiter another owner holds');
        // A waiter on its planned fallback farms the fallback's NPC (the route search's answer).
        assert.strictEqual(planned(109).spotId, current.id);
        assert.strictEqual(proposals.get(109).result?.debug?.targetNpcId, 321, 'a waiter on its fallback farms its planned NPC');
        const shopper = proposals.get(110)?.nextState || commands.get(110)?.precomputedPlan?.plannedState;
        assert(shopper, 'the clan member on a market plan is stepped');
        assert.notStrictEqual(shopper.stats.eventWait, 'clan_party_assembly', 'no clan wait holds a bot forming never takes');
        assert.notStrictEqual(shopper.activity, 'party_wait');
        assert.notStrictEqual(lifecycleKind(shopper), 'event_driven', 'its own plan steps it, no party it cannot join');
        const released = proposals.get(111)?.nextState;
        assert(released, 'the released clan waiter is stepped by the worker, not handed to main');
        assert.strictEqual(released.activity, 'hunting', 'a waiter the clan call no longer holds hunts again');
        assert.strictEqual(released.stats.eventWait, undefined, 'no wait holds it');
        assert.strictEqual(released.stats.partyRequest, undefined, 'it asks for no clan party');
        assert.strictEqual(planned(106).stats.equipmentPlan.inputPreparation.recipeId, 447,
            'the worker must not replace the selected plan with a bare wish that drops the retained project');
    } finally {
        await worker.terminate();
    }
    console.log('Cold worker party wait checks passed');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
