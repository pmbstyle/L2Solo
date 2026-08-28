const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const HotActivation = invoke('GameServer/Bot/Population/HotActivation');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const BotManager = invoke('GameServer/Bot/BotManager');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

const originals = {
    active: PartyState.active,
    counts: PartyState.counts,
    statesForParty: LifeState.statesForParty,
    statesForParties: LifeState.statesForParties,
    coldPartyCandidateProjections: LifeState.coldPartyCandidateProjections,
    coldPartyCandidateCount: LifeState.coldPartyCandidateCount,
    coldPartyCandidates: LifeState.coldPartyCandidates,
    coldPartyCandidatesForSpots: LifeState.coldPartyCandidatesForSpots,
    assignParty: LifeState.assignParty,
    partyRequirementCounts: LifeState.partyRequirementCounts,
    clearParty: LifeState.clearParty,
    releaseDissolvedPartyMembers: LifeState.releaseDissolvedPartyMembers,
    cachedState: LifeState.cachedState,
    createOrUpdate: PartyState.createOrUpdate,
    setStatus: PartyState.setStatus,
    loadAndSpawnBot: BotManager.loadAndSpawnBot,
    findCurrentSpot: SpotService.findCurrentSpot,
    record: LifeEvents.record,
    handoffToMain: ColdSimulationOwner.handoffToMain,
    acceptColdState: ColdSimulationCoordinator.acceptColdState,
    partyMinSize: Config.partyMinSize,
    partyMaxSize: Config.partyMaxSize,
    maxBackgroundParties: Config.maxBackgroundParties,
    partyFormationBatchSize: Config.partyFormationBatchSize
};
const originalFormationState = {
    resolving: PopulationService.resolving,
    partyFormationRunning: PopulationService.partyFormationRunning,
    partyFormationPending: PopulationService.partyFormationPending,
    nextPartyRequestCleanupAt: PopulationService.nextPartyRequestCleanupAt
};

async function run() {
    Config.partyMinSize = 2;
    Config.partyMaxSize = 5;
    let projectionCalls = 0;
    PartyState.active = () => [];
    PartyState.counts = () => ({ active: 0 });
    LifeState.coldPartyCandidateProjections = () => {
        projectionCalls += 1;
        return Promise.resolve([]);
    };
    LifeState.coldPartyCandidates = () => Promise.resolve([]);
    LifeState.coldPartyCandidatesForSpots = () => Promise.resolve([]);
    LifeState.statesForParties = () => Promise.resolve(new Map());
    PopulationService.resolving = false;
    PopulationService.partyFormationRunning = false;
    PopulationService.nextPartyRequestCleanupAt = Infinity;
    await PopulationService.formBackgroundParties();
    assert.strictEqual(projectionCalls, 1, 'party formation must discover the complete lightweight candidate projection once');

    PartyState.active = originals.active;
    PartyState.counts = originals.counts;
    LifeState.coldPartyCandidateCount = originals.coldPartyCandidateCount;
    LifeState.coldPartyCandidates = originals.coldPartyCandidates;
    LifeState.coldPartyCandidatesForSpots = originals.coldPartyCandidatesForSpots;
    LifeState.statesForParties = originals.statesForParties;
    LifeState.coldPartyCandidateProjections = originals.coldPartyCandidateProjections;

    const party = { partyId: 'bgp_1', leaderId: 1, memberIds: [1, 2], spotId: 'cruma', stats: {} };
    const members = [
        { characterId: 1, name: 'Tank', level: 15, party: { role: 'tank' } },
        { characterId: 2, name: 'Healer', level: 15, party: { role: 'healer' } }
    ];
    const candidates = [
        { characterId: 3, name: 'Buffer', level: 15, spotId: 'cruma', party: { role: 'buffer' } },
        { characterId: 4, name: 'Dps', level: 16, spotId: 'cruma', party: { role: 'dps' } },
        { characterId: 5, name: 'FarAway', level: 25, spotId: 'cruma', party: { role: 'buffer' } },
        { characterId: 6, name: 'OtherSpot', level: 15, spotId: 'dion', party: { role: 'buffer' } }
    ];
    const assigned = [];
    const events = [];
    let saved = null;

    PartyState.active = () => [party];
    LifeState.statesForParty = () => Promise.resolve(members);
    LifeState.statesForParties = () => Promise.resolve(new Map([['bgp_1', members]]));
    LifeState.assignParty = (state, partyId, role, leaderId) => {
        assigned.push({ state, partyId, role, leaderId });
        return Promise.resolve(state);
    };
    PartyState.createOrUpdate = (nextParty) => {
        saved = nextParty;
        return Promise.resolve(nextParty);
    };
    LifeEvents.record = (...args) => {
        events.push(args);
        return Promise.resolve(null);
    };

    const recruited = await PopulationService.recruitBackgroundMembers(candidates);
    assert.deepStrictEqual([...recruited], [3, 4]);
    assert.deepStrictEqual(assigned.map((entry) => entry.state.characterId), [3, 4]);
    assert.deepStrictEqual(saved.memberIds, [1, 2, 3, 4]);
    assert.deepStrictEqual(saved.roleCoverage, { tank: 1, healer: 1, buffer: 1, dps: 1 });
    assert.strictEqual(saved.leaderId, 1, 'recruitment must preserve an attached party leader');
    assert.strictEqual(events.length, 1);

    const staleLeaderParty = { partyId: 'bgp_stale_leader', leaderId: 999, memberIds: [1, 2], spotId: 'cruma', stats: {} };
    let staleLeaderSaved = null;
    PartyState.active = () => [staleLeaderParty];
    LifeState.statesForParties = () => Promise.resolve(new Map([['bgp_stale_leader', members]]));
    PartyState.createOrUpdate = (nextParty) => {
        staleLeaderSaved = nextParty;
        return Promise.resolve(nextParty);
    };
    await PopulationService.recruitBackgroundMembers([
        { characterId: 7, name: 'StaleLeaderRecruit', level: 15, spotId: 'cruma', party: { role: 'dps' } }
    ]);
    assert.strictEqual(staleLeaderSaved.leaderId, 1,
        'recruitment must re-elect an attached member when the stored leader has already departed');
    assert.deepStrictEqual(
        assigned.filter((entry) => entry.partyId === 'bgp_stale_leader').map((entry) => entry.leaderId),
        [1, 1, 1],
        'retained members and recruits must receive the elected leader id'
    );

    const sharedParties = [
        { partyId: 'bgp_shared_a', leaderId: 50, memberIds: [50, 51, 52, 53], spotId: 'cruma', stats: {} },
        { partyId: 'bgp_shared_b', leaderId: 54, memberIds: [54, 55, 56, 57], spotId: 'cruma', stats: {} }
    ];
    const sharedMembers = new Map(sharedParties.map((sharedParty) => [
        sharedParty.partyId,
        sharedParty.memberIds.map((characterId, index) => ({
            characterId,
            name: `Member${characterId}`,
            level: 15,
            spotId: 'cruma',
            party: { role: ['tank', 'healer', 'buffer', 'dps'][index] }
        }))
    ]));
    const sharedAssignments = [];
    PartyState.active = () => sharedParties;
    LifeState.statesForParties = () => Promise.resolve(sharedMembers);
    LifeState.assignParty = (state, partyId) => {
        sharedAssignments.push({ characterId: state.characterId, partyId });
        return Promise.resolve(state);
    };
    const sharedCandidates = await PopulationService.recruitBackgroundMembers([
        { characterId: 60, name: 'SharedOne', level: 15, spotId: 'cruma', party: { role: 'dps' } },
        { characterId: 61, name: 'SharedTwo', level: 15, spotId: 'cruma', party: { role: 'dps' } }
    ]);
    assert.deepStrictEqual([...sharedCandidates].sort((a, b) => a - b), [60, 61], 'a candidate must be claimed by only one active party per formation pass');
    assert.deepStrictEqual(sharedAssignments.map((entry) => entry.characterId).sort((a, b) => a - b), [60, 61]);

    const fairGroups = PopulationService.groupPartyCandidatesBySpot([
        { characterId: 101, level: 10, spotId: 'crowded', activity: 'party_wait', timing: { activityStartedAt: 20 } },
        { characterId: 102, level: 10, spotId: 'crowded', activity: 'party_wait', timing: { activityStartedAt: 20 } },
        { characterId: 103, level: 10, spotId: 'crowded', activity: 'party_wait', timing: { activityStartedAt: 20 } },
        { characterId: 104, level: 10, spotId: 'under_served', activity: 'party_wait', timing: { activityStartedAt: 10 } },
        { characterId: 105, level: 10, spotId: 'under_served', activity: 'party_wait', timing: { activityStartedAt: 10 } }
    ], {
        prioritizePartyWait: true,
        activePartiesBySpot: new Map([['crowded', 5]])
    });
    assert.strictEqual(fairGroups[0][0].spotId, 'under_served', 'party-wait groups must prefer a ground with no existing party over a larger but already saturated queue');

    const objectiveGroups = PopulationService.groupPartyCandidatesByObjective([
        { characterId: 111, level: 25, spotId: 'fallback', activity: 'hunting', stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'direct_drop:cruma:701:88', spotId: 'cruma' } } },
        { characterId: 112, level: 26, spotId: 'fallback', activity: 'hunting', stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'direct_drop:cruma:701:88', spotId: 'cruma' } } },
        { characterId: 113, level: 25, spotId: 'fallback', activity: 'hunting', stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'craft:cruma:701:1988', spotId: 'cruma' } } }
    ], { prioritizePartyWait: true });
    assert.strictEqual(objectiveGroups.length, 2, 'party formation must keep different acquisition objectives separate even on one spot');
    assert.strictEqual(objectiveGroups[0].length, 2, 'compatible requesters must share an objective group');
    const clanObjectiveGroups = PopulationService.groupPartyCandidatesByObjective([
        { characterId: 114, level: 25, stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'direct_drop:cruma:701', clanGoalKey: 'clan-equipment:77:114:88:7' } } },
        { characterId: 115, level: 25, stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'direct_drop:cruma:701', clanGoalKey: 'clan-equipment:78:115:88:7' } } }
    ]);
    assert.strictEqual(clanObjectiveGroups.length, 2,
        'different clan equipment goals must never merge merely because they hunt the same NPC');
    const prioritizedClanGroups = PopulationService.groupPartyCandidatesByObjective([
        { characterId: 116, level: 25, stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'large-normal' } } },
        { characterId: 117, level: 25, stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'large-normal' } } },
        { characterId: 118, level: 25, stats: { clanPartyObjective: { status: 'open', priority: 'required', objectiveKey: 'clan-route', clanId: 77, clanGoalKey: 'clan-equipment:77:118:88:7', clanOperation: 'equipment' } } }
    ], { prioritizePartyWait: true });
    assert.strictEqual(prioritizedClanGroups[0][0].characterId, 118,
        'clan equipment groups must be admitted before larger ordinary required queues');
    assert.strictEqual(PopulationService.partyObjectivesShareRoute(
        { spotId: 'cruma', npcId: 701, clanGoalKey: 'clan-equipment:77:114:88:7' },
        { spotId: 'cruma', npcId: 701, clanGoalKey: 'clan-equipment:78:115:88:7' }
    ), false, 'route compatibility must preserve clan ownership');
    assert.deepStrictEqual(
        PopulationService.partyLimitsForObjective({
            clanId: 77,
            clanOperation: 'equipment',
            minPartySize: 5,
            maxPartySize: 9,
            levelRange: 99
        }),
        { minSize: 5, maxSize: 9, levelRange: 99 },
        'a clan equipment objective may form one native nine-member party'
    );
    assert.strictEqual(
        PopulationService.requiresClanEquipmentParty({
            stats: {
                partyRequest: {
                    status: 'open',
                    priority: 'required',
                    clanId: 77,
                    clanOperation: 'equipment'
                }
            }
        }),
        true,
        'a required clan equipment roster must override elective persona party preferences'
    );
    assert.strictEqual(
        PartyRequestPlanner.partyObjectiveForState({
            stats: {
                partyRequest: { status: 'open', priority: 'required', objectiveKey: 'personal-route' },
                clanPartyObjective: {
                    status: 'open', priority: 'required', objectiveKey: 'clan-route', clanId: 77,
                    clanGoalKey: 'clan-equipment:77:114:88:7', clanOperation: 'equipment'
                }
            }
        }).objectiveKey,
        'clan-route',
        'a stale personal request must not hide the durable clan party objective'
    );
    assert.strictEqual(
        PopulationService.partyTargetNpcId({ stats: { objective: { strategy: 'craft', npcId: 701 } } }, { stats: {} }),
        701,
        'craft acquisition objectives must forward their material NPC to party combat'
    );

    const electiveParty = { partyId: 'bgp_elective', leaderId: 11, memberIds: [11, 12], spotId: 'cruma', startedAt: 1 };
    const requiredParty = { partyId: 'bgp_required', leaderId: 21, memberIds: [21, 22], spotId: 'dion', startedAt: 2 };
    const reclaimed = [];
    const dissolvedReleases = [];
    PartyState.active = () => [electiveParty, requiredParty];
    PartyState.setStatus = (partyId, status) => {
        reclaimed.push({ partyId, status });
        return Promise.resolve({ partyId, status });
    };
    LifeState.releaseDissolvedPartyMembers = (partyId, reason) => {
        dissolvedReleases.push({ partyId, reason });
        return Promise.resolve(2);
    };
    LifeState.partyRequirementCounts = () => Promise.resolve([
        { partyId: 'bgp_elective', requiredMembers: 0 },
        { partyId: 'bgp_required', requiredMembers: 2 }
    ]);
    Config.maxBackgroundParties = 2;
    Config.partyFormationBatchSize = 2;
    assert.strictEqual(PopulationService.maxBackgroundPartiesForBacklog(0), 2, 'without a backlog the base party capacity must remain unchanged');
    assert(PopulationService.maxBackgroundPartiesForBacklog(1000) > 2, 'a sustained party-wait backlog should open bounded spare party capacity');
    const released = await PopulationService.reclaimBackgroundPartyCapacity([
        { characterId: 31 }, { characterId: 32 }, { characterId: 33 }, { characterId: 34 }
    ]);
    assert.deepStrictEqual(released.map((party) => party.partyId), ['bgp_elective']);
    assert.deepStrictEqual(reclaimed, [{ partyId: 'bgp_elective', status: 'dissolved' }]);
    assert.deepStrictEqual(dissolvedReleases, [{ partyId: 'bgp_elective', reason: 'party_capacity_reclaimed' }]);

    reclaimed.length = 0;
    dissolvedReleases.length = 0;
    const ordinaryRequiredA = { ...requiredParty, partyId: 'bgp_required_a', startedAt: 1, stats: { objective: { priority: 'required' } } };
    const ordinaryRequiredB = { ...requiredParty, partyId: 'bgp_required_b', startedAt: 2, stats: { objective: { priority: 'required' } } };
    PartyState.active = () => [ordinaryRequiredA, ordinaryRequiredB];
    LifeState.partyRequirementCounts = () => Promise.resolve([
        { partyId: 'bgp_required_a', requiredMembers: 2 },
        { partyId: 'bgp_required_b', requiredMembers: 2 }
    ]);
    const clanWaiters = Array.from({ length: 5 }, (_, index) => ({
        characterId: 40 + index,
        stats: {
            clanPartyObjective: {
                status: 'open', priority: 'required', clanId: 77, clanOperation: 'equipment',
                clanGoalKey: 'clan-equipment:77:40:88:7', objectiveKey: 'clan-route'
            }
        }
    }));
    const clanReleased = await PopulationService.reclaimBackgroundPartyCapacity(clanWaiters);
    assert.deepStrictEqual(clanReleased.map((party) => party.partyId), ['bgp_required_a'],
        'a saturated queue must yield one ordinary required party slot to a missing clan equipment group');

    const activationOrder = [];
    ColdSimulationOwner.handoffToMain = async (state) => {
        activationOrder.push(`handoff:${state.characterId}`);
        return {
            ok: true,
            ownerId: ColdSimulationOwner.LEGACY_OWNER_ID,
            revision: Number(state.simulation?.revision || 0),
            leaseId: null,
            leaseUntil: 0
        };
    };
    const groupedState = {
        characterId: 91001,
        accountName: 'bot_activation_probe',
        name: 'ActivationProbe',
        phase: 'cold',
        activity: 'grouped',
        homeRegion: 'human',
        loc: { locX: -71300, locY: 258000, locZ: -3100 },
        stats: {},
        party: { partyId: 'bgp_activation_probe', leaderId: 91001 }
    };
    const releasedState = {
        ...groupedState,
        activity: 'hunting',
        party: { partyId: null, leaderId: null }
    };
    PartyState.setStatus = async (partyId, status) => {
        activationOrder.push(`status:${partyId}:${status}`);
    };
    LifeState.releaseDissolvedPartyMembers = async (partyId, reason) => {
        activationOrder.push(`release:${partyId}:${reason}`);
        return 2;
    };
    LifeState.cachedState = (characterId) => characterId === groupedState.characterId ? releasedState : null;
    SpotService.findCurrentSpot = () => null;
    BotManager.loadAndSpawnBot = (_accountName, options) => {
        activationOrder.push(`spawn:${options.coldLifeState?.party?.partyId || 'solo'}`);
        return Promise.resolve({ actor: {} });
    };

    const activated = await HotActivation.activate(groupedState, 'party_invite', { keepStoreLocation: true });
    assert.strictEqual(activated.ok, true, 'an explicitly requested grouped bot should still materialize');
    assert.deepStrictEqual(
        activationOrder,
        [
            'handoff:91001',
            'status:bgp_activation_probe:dissolved',
            'release:bgp_activation_probe:hot_activation_party_invite',
            'spawn:solo'
        ],
        'background party cleanup must finish before a member spawns from the released solo snapshot'
    );

    activationOrder.length = 0;
    const travelingState = {
        ...groupedState,
        characterId: 91005,
        name: 'TravelingConstProbe',
        activity: 'traveling',
        party: { partyId: null, leaderId: null },
        stats: {
            travel: {
                from: groupedState.loc,
                to: { locX: -50000, locY: 250000, locZ: -3000 },
                arrivalAt: Date.now() + 20000
            }
        }
    };
    const blockedTravel = await HotActivation.activate(travelingState, 'remote_invite', {
        keepStoreLocation: true
    });
    assert.strictEqual(blockedTravel.reason, 'in_transit', 'ordinary activation must not interrupt background travel');
    let summonedState = null;
    LifeState.cachedState = () => null;
    BotManager.loadAndSpawnBot = (_accountName, options) => {
        summonedState = options.coldLifeState;
        return Promise.resolve({ actor: {} });
    };
    const summonedTravel = await HotActivation.activate(travelingState, 'remote_invite', {
        keepStoreLocation: true,
        interruptBackgroundActivity: true
    });
    assert.strictEqual(summonedTravel.ok, true, 'a const summon must interrupt background travel and activate the bot');
    assert.strictEqual(summonedState.activity, 'hunting', 'the interrupted travel must not survive into hot AI state');
    assert.strictEqual(summonedState.stats.travel, null, 'the stale background route must be cleared before the bot spawns');

    activationOrder.length = 0;
    const blockedState = {
        ...groupedState,
        characterId: 91002,
        name: 'BlockedActivationProbe'
    };
    LifeState.releaseDissolvedPartyMembers = async () => 0;
    LifeState.cachedState = (characterId) => characterId === blockedState.characterId ? blockedState : null;
    const blockedActivation = await HotActivation.activate(blockedState, 'party_invite', { keepStoreLocation: true });
    assert.strictEqual(blockedActivation.ok, false, 'a member must not spawn while its persisted party link is still present');
    assert.strictEqual(blockedActivation.reason, 'activation_prepare_failed');
    assert(!activationOrder.some((entry) => entry.startsWith('spawn:')), 'failed party cleanup must stop hot activation before spawning');

    activationOrder.length = 0;
    const failedSpawnState = {
        ...groupedState,
        characterId: 91004,
        name: 'FailedSpawnProbe'
    };
    LifeState.releaseDissolvedPartyMembers = async () => 2;
    LifeState.cachedState = (characterId) => characterId === failedSpawnState.characterId
        ? { ...releasedState, characterId: failedSpawnState.characterId, name: failedSpawnState.name }
        : null;
    BotManager.loadAndSpawnBot = () => Promise.resolve(null);
    ColdSimulationCoordinator.acceptColdState = async (state) => {
        activationOrder.push(`restore:${state.characterId}`);
        return { ok: true, reason: 'restored_for_test' };
    };
    const failedSpawn = await HotActivation.activate(failedSpawnState, 'spawn_failure', { keepStoreLocation: true });
    assert.strictEqual(failedSpawn.ok, false, 'failed hot spawn must be reported as failed');
    assert.strictEqual(activationOrder.at(-1), 'restore:91004', 'failed activation must return its released state to the cold worker');

    activationOrder.length = 0;
    const concurrentState = {
        ...groupedState,
        characterId: 91003,
        name: 'ConcurrentActivationProbe'
    };
    const concurrentReleasedState = {
        ...concurrentState,
        activity: 'hunting',
        party: { partyId: null, leaderId: null }
    };
    BotManager.loadAndSpawnBot = (_accountName, options) => {
        activationOrder.push(`spawn:${options.coldLifeState?.party?.partyId || 'solo'}`);
        return Promise.resolve({ actor: {} });
    };
    let releaseStatus;
    const releaseGate = new Promise((resolve) => { releaseStatus = resolve; });
    PartyState.setStatus = async () => releaseGate;
    LifeState.releaseDissolvedPartyMembers = async () => 2;
    LifeState.cachedState = (characterId) => characterId === concurrentState.characterId ? concurrentReleasedState : null;

    const firstActivation = HotActivation.activate(concurrentState, 'concurrent_first', { keepStoreLocation: true });
    const secondActivation = HotActivation.activate(concurrentState, 'concurrent_second', { keepStoreLocation: true });
    await Promise.resolve();
    releaseStatus();
    const concurrentResults = await Promise.all([firstActivation, secondActivation]);
    assert.strictEqual(concurrentResults.filter((result) => result.ok).length, 1, 'only one concurrent request may activate a character');
    assert.strictEqual(concurrentResults.filter((result) => result.reason === 'activation_pending').length, 1, 'the competing request must observe the early activation reservation');
    assert.strictEqual(activationOrder.filter((entry) => entry.startsWith('spawn:')).length, 1, 'concurrent activation must create exactly one hot AI session');
    console.log('Bot background party recruitment checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    PartyState.active = originals.active;
    PartyState.counts = originals.counts;
    LifeState.statesForParty = originals.statesForParty;
    LifeState.statesForParties = originals.statesForParties;
    LifeState.coldPartyCandidateProjections = originals.coldPartyCandidateProjections;
    LifeState.coldPartyCandidateCount = originals.coldPartyCandidateCount;
    LifeState.coldPartyCandidates = originals.coldPartyCandidates;
    LifeState.coldPartyCandidatesForSpots = originals.coldPartyCandidatesForSpots;
    LifeState.assignParty = originals.assignParty;
    LifeState.partyRequirementCounts = originals.partyRequirementCounts;
    LifeState.clearParty = originals.clearParty;
    LifeState.releaseDissolvedPartyMembers = originals.releaseDissolvedPartyMembers;
    LifeState.cachedState = originals.cachedState;
    PartyState.createOrUpdate = originals.createOrUpdate;
    PartyState.setStatus = originals.setStatus;
    BotManager.loadAndSpawnBot = originals.loadAndSpawnBot;
    SpotService.findCurrentSpot = originals.findCurrentSpot;
    LifeEvents.record = originals.record;
    ColdSimulationOwner.handoffToMain = originals.handoffToMain;
    ColdSimulationCoordinator.acceptColdState = originals.acceptColdState;
    Config.partyMinSize = originals.partyMinSize;
    Config.partyMaxSize = originals.partyMaxSize;
    Config.maxBackgroundParties = originals.maxBackgroundParties;
    Config.partyFormationBatchSize = originals.partyFormationBatchSize;
    Object.assign(PopulationService, originalFormationState);
});
