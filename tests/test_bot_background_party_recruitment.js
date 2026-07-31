const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const HotActivation = invoke('GameServer/Bot/Population/HotActivation');
const BotManager = invoke('GameServer/Bot/BotManager');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

const originals = {
    active: PartyState.active,
    statesForParty: LifeState.statesForParty,
    assignParty: LifeState.assignParty,
    partyRequirementCounts: LifeState.partyRequirementCounts,
    clearParty: LifeState.clearParty,
    cachedState: LifeState.cachedState,
    createOrUpdate: PartyState.createOrUpdate,
    setStatus: PartyState.setStatus,
    loadAndSpawnBot: BotManager.loadAndSpawnBot,
    findCurrentSpot: SpotService.findCurrentSpot,
    record: LifeEvents.record,
    partyMinSize: Config.partyMinSize,
    partyMaxSize: Config.partyMaxSize,
    maxBackgroundParties: Config.maxBackgroundParties,
    partyFormationBatchSize: Config.partyFormationBatchSize
};

async function run() {
    Config.partyMinSize = 2;
    Config.partyMaxSize = 5;
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
    assert.strictEqual(events.length, 1);

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

    const electiveParty = { partyId: 'bgp_elective', leaderId: 11, memberIds: [11, 12], spotId: 'cruma', startedAt: 1 };
    const requiredParty = { partyId: 'bgp_required', leaderId: 21, memberIds: [21, 22], spotId: 'dion', startedAt: 2 };
    const reclaimed = [];
    PartyState.active = () => [electiveParty, requiredParty];
    PartyState.setStatus = (partyId, status) => {
        reclaimed.push({ partyId, status });
        return Promise.resolve({ partyId, status });
    };
    LifeState.clearParty = () => Promise.resolve(2);
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

    const activationOrder = [];
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
    LifeState.clearParty = async (partyId, reason) => {
        activationOrder.push(`clear:${partyId}:${reason}`);
        return 2;
    };
    LifeState.cachedState = (characterId) => characterId === groupedState.characterId ? releasedState : null;
    SpotService.findCurrentSpot = () => null;
    BotManager.loadAndSpawnBot = (_accountName, options) => {
        activationOrder.push(`spawn:${options.coldLifeState?.party?.partyId || 'solo'}`);
    };

    const activated = await HotActivation.activate(groupedState, 'party_invite', { keepStoreLocation: true });
    assert.strictEqual(activated.ok, true, 'an explicitly requested grouped bot should still materialize');
    assert.deepStrictEqual(
        activationOrder,
        [
            'status:bgp_activation_probe:dissolved',
            'clear:bgp_activation_probe:hot_activation_party_invite',
            'spawn:solo'
        ],
        'background party cleanup must finish before a member spawns from the released solo snapshot'
    );

    activationOrder.length = 0;
    const blockedState = {
        ...groupedState,
        characterId: 91002,
        name: 'BlockedActivationProbe'
    };
    LifeState.clearParty = async () => 0;
    LifeState.cachedState = (characterId) => characterId === blockedState.characterId ? blockedState : null;
    const blockedActivation = await HotActivation.activate(blockedState, 'party_invite', { keepStoreLocation: true });
    assert.strictEqual(blockedActivation.ok, false, 'a member must not spawn while its persisted party link is still present');
    assert.strictEqual(blockedActivation.reason, 'activation_prepare_failed');
    assert(!activationOrder.some((entry) => entry.startsWith('spawn:')), 'failed party cleanup must stop hot activation before spawning');

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
    let releaseStatus;
    const releaseGate = new Promise((resolve) => { releaseStatus = resolve; });
    PartyState.setStatus = async () => releaseGate;
    LifeState.clearParty = async () => 2;
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
    LifeState.statesForParty = originals.statesForParty;
    LifeState.assignParty = originals.assignParty;
    LifeState.partyRequirementCounts = originals.partyRequirementCounts;
    LifeState.clearParty = originals.clearParty;
    LifeState.cachedState = originals.cachedState;
    PartyState.createOrUpdate = originals.createOrUpdate;
    PartyState.setStatus = originals.setStatus;
    BotManager.loadAndSpawnBot = originals.loadAndSpawnBot;
    SpotService.findCurrentSpot = originals.findCurrentSpot;
    LifeEvents.record = originals.record;
    Config.partyMinSize = originals.partyMinSize;
    Config.partyMaxSize = originals.partyMaxSize;
    Config.maxBackgroundParties = originals.maxBackgroundParties;
    Config.partyFormationBatchSize = originals.partyFormationBatchSize;
});
