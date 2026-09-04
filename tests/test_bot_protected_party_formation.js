const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const ColdCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const RequiredPartyFormation = require('../src/GameServer/Bot/Population/RequiredPartyFormation');

function candidate(characterId, options = {}) {
    const requestedAt = Number(options.requestedAt || 1000);
    return {
        characterId,
        name: `Required${characterId}`,
        level: Number(options.level || 40),
        phase: 'cold',
        activity: 'party_wait',
        spotId: options.spotId || 'cruma_tower',
        party: { partyId: null, role: options.role || 'dps', leaderId: null },
        stats: {
            role: options.role || 'dps',
            partyRequest: {
                status: 'open', priority: 'required', requestedAt,
                spotId: options.spotId || 'cruma_tower', npcId: 20001
            }
        },
        timing: { activityStartedAt: requestedAt },
        simulation: { ownerId: 'legacy_main', revision: Number(options.revision || 3) },
        updatedAt: Number(options.updatedAt || 5000)
    };
}

const crowded = Array.from({ length: 20 }, (_, index) => candidate(index + 1, {
    requestedAt: 1000 + index,
    role: index === 1 ? 'tank' : 'dps'
}));
const proposal = RequiredPartyFormation.proposalFromStates(crowded, { candidateLimit: 12 });
assert.strictEqual(proposal.requiredCount, 20, 'worker must report the complete required backlog');
assert.strictEqual(proposal.candidates.length, 12, 'worker response must obey the candidate cap');
assert.strictEqual(proposal.candidates[0].characterId, 1, 'the oldest compatible request must lead the bounded window');

const incompatible = [candidate(101, { level: 10 }), candidate(102, { level: 25 })];
assert.deepStrictEqual(
    RequiredPartyFormation.proposalFromStates(incompatible, { candidateLimit: 12 }).candidates,
    [],
    'a level-incompatible pair must not reach the main-thread hydration path'
);

const laterCompatibleCluster = [
    candidate(111, { level: 10, requestedAt: 1000 }),
    candidate(112, { level: 20, requestedAt: 1001 }),
    candidate(113, { level: 20, requestedAt: 1002 })
];
assert.deepStrictEqual(
    RequiredPartyFormation.proposalFromStates(laterCompatibleCluster, { candidateLimit: 12, levelRange: 4 })
        .candidates.map((entry) => entry.characterId),
    [112, 113],
    'an isolated oldest request must not hide a later compatible level cluster'
);

const originals = {
    activity: PopulationService.playerActivityProfile,
    lag: Metrics.currentEventLoopLag,
    stats: Database.stats,
    ready: Database.isReady,
    statesByIds: LifeState.statesByIds,
    counts: PartyState.counts,
    snapshot: ColdCoordinator.snapshot,
    request: ColdCoordinator.requestRequiredPartyFormation,
    interval: Config.protectedPartyFormationIntervalMs,
    poll: Config.protectedPartyFormationPollMs,
    maxBackoff: Config.protectedPartyFormationMaxBackoffMs,
    mainBudget: Config.protectedPartyFormationMainBudgetMs
};

(async () => {
    Config.protectedPartyFormationIntervalMs = 1000;
    Config.protectedPartyFormationPollMs = 100;
    Config.protectedPartyFormationMaxBackoffMs = 4000;
    Config.protectedPartyFormationMainBudgetMs = 1000;
    PopulationService.playerActivityProfile = () => ({ protected: true, realPlayers: 1, mode: 'player' });
    Metrics.currentEventLoopLag = () => 0;
    Database.stats = () => ({ pending: 0, checkpoint: { inFlight: false } });
    Database.isReady = () => true;
    PartyState.counts = () => ({ active: 0 });
    ColdCoordinator.snapshot = () => ({ ready: true, snapshotsLoaded: true, queue: { depth: 0, flushing: false } });
    ColdCoordinator.requestRequiredPartyFormation = async () => ({
        ok: true,
        requiredCount: 2,
        spotId: 'cruma_tower',
        minSize: 2,
        maxSize: 5,
        levelRange: 4,
        candidates: [candidate(201), candidate(202)]
    });
    LifeState.statesByIds = async () => [
        candidate(201, { updatedAt: 5001 }),
        candidate(202, { revision: 4 })
    ];
    PopulationService.resolving = false;
    PopulationService.partyFormationRunning = false;
    PopulationService.nextProtectedPartyFormationAt = 0;
    PopulationService.protectedPartyFormationFailures = 0;

    const before = Date.now();
    assert.deepStrictEqual(await PopulationService.formProtectedRequiredParty(before), [],
        'stale worker candidates must be rejected before party creation');
    assert.strictEqual(PopulationService.protectedPartyFormationFailures, 1,
        'a stale proposal must engage protected-path backoff');
    assert(PopulationService.nextProtectedPartyFormationAt >= before + 1900,
        'the first failed attempt must wait roughly two base intervals');

    let requests = 0;
    ColdCoordinator.requestRequiredPartyFormation = async () => { requests += 1; return { ok: true, candidates: [] }; };
    Database.stats = () => ({ pending: 1, checkpoint: { inFlight: false } });
    PopulationService.nextProtectedPartyFormationAt = 0;
    PopulationService.protectedPartyFormationFailures = 0;
    await PopulationService.formProtectedRequiredParty(Date.now());
    assert.strictEqual(requests, 0, 'a busy DB queue must stop before worker selection');
    assert.strictEqual(PopulationService.protectedPartyFormationFailures, 0,
        'transient pressure must poll again without escalating failure backoff');

    Database.stats = () => ({ pending: 0, checkpoint: { inFlight: false } });
    Config.protectedPartyFormationMainBudgetMs = 1;
    ColdCoordinator.requestRequiredPartyFormation = () => new Promise((resolve) => setTimeout(() => resolve({
        ok: true,
        requiredCount: 0,
        candidates: []
    }), 10));
    PopulationService.nextProtectedPartyFormationAt = 0;
    PopulationService.protectedPartyFormationFailures = 0;
    await PopulationService.formProtectedRequiredParty(Date.now());
    assert.strictEqual(PopulationService.protectedPartyFormationFailures, 0,
        'worker IPC latency must not consume the protected main-thread budget');

    console.log('Protected required-party worker selection, stale validation, limits and backoff checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    PopulationService.playerActivityProfile = originals.activity;
    Metrics.currentEventLoopLag = originals.lag;
    Database.stats = originals.stats;
    Database.isReady = originals.ready;
    LifeState.statesByIds = originals.statesByIds;
    PartyState.counts = originals.counts;
    ColdCoordinator.snapshot = originals.snapshot;
    ColdCoordinator.requestRequiredPartyFormation = originals.request;
    Config.protectedPartyFormationIntervalMs = originals.interval;
    Config.protectedPartyFormationPollMs = originals.poll;
    Config.protectedPartyFormationMaxBackoffMs = originals.maxBackoff;
    Config.protectedPartyFormationMainBudgetMs = originals.mainBudget;
    PopulationService.partyFormationRunning = false;
    PopulationService.nextProtectedPartyFormationAt = 0;
    PopulationService.protectedPartyFormationFailures = 0;
});
