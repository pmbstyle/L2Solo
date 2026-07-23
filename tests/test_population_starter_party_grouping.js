const assert = require('assert');

require('../src/Global');

const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');

function starter(characterId, starterRegion, spotId) {
    return {
        characterId,
        level: 1,
        spotId,
        party: { role: 'dps' },
        stats: {
            populationWave: 1,
            starterRegion,
            equipmentPlan: { status: 'active', next: { spotId: '7_40' } }
        }
    };
}

const human = starter(1, 'human', 'starter_human');
const elf = starter(2, 'elf', 'starter_elf');
const groups = PopulationService.groupBySpot([human, elf]);
assert.deepStrictEqual(groups.map((group) => group.map((state) => state.characterId)), [[1], [2]],
    'starter cohorts with the same gear target must remain grouped by their physical spot');

const originalFindForState = SpotProfiles.findForState;
let partyLeader = null;
SpotProfiles.findForState = (state) => {
    partyLeader = state;
    return { id: state.spotId };
};
try {
    const partySpot = PopulationService.partySpotForLeader(human);
    assert.strictEqual(partyLeader.spotId, 'starter_human',
        'starter party formation must retain the leader physical spot');
    assert.strictEqual(partySpot.id, 'starter_human');
} finally {
    SpotProfiles.findForState = originalFindForState;
}

console.log('Starter party grouping checks passed');
