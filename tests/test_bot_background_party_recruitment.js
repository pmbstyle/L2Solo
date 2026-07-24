const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originals = {
    active: PartyState.active,
    statesForParty: LifeState.statesForParty,
    assignParty: LifeState.assignParty,
    partyRequirementCounts: LifeState.partyRequirementCounts,
    clearParty: LifeState.clearParty,
    createOrUpdate: PartyState.createOrUpdate,
    setStatus: PartyState.setStatus,
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
    const released = await PopulationService.reclaimBackgroundPartyCapacity([
        { characterId: 31 }, { characterId: 32 }, { characterId: 33 }, { characterId: 34 }
    ]);
    assert.deepStrictEqual(released.map((party) => party.partyId), ['bgp_elective']);
    assert.deepStrictEqual(reclaimed, [{ partyId: 'bgp_elective', status: 'dissolved' }]);
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
    PartyState.createOrUpdate = originals.createOrUpdate;
    PartyState.setStatus = originals.setStatus;
    LifeEvents.record = originals.record;
    Config.partyMinSize = originals.partyMinSize;
    Config.partyMaxSize = originals.partyMaxSize;
    Config.maxBackgroundParties = originals.maxBackgroundParties;
    Config.partyFormationBatchSize = originals.partyFormationBatchSize;
});
