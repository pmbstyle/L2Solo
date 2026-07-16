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
    createOrUpdate: PartyState.createOrUpdate,
    record: LifeEvents.record,
    partyMinSize: Config.partyMinSize,
    partyMaxSize: Config.partyMaxSize
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
    console.log('Bot background party recruitment checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    PartyState.active = originals.active;
    LifeState.statesForParty = originals.statesForParty;
    LifeState.assignParty = originals.assignParty;
    PartyState.createOrUpdate = originals.createOrUpdate;
    LifeEvents.record = originals.record;
    Config.partyMinSize = originals.partyMinSize;
    Config.partyMaxSize = originals.partyMaxSize;
});
