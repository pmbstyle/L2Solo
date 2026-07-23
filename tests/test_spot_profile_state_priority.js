const assert = require('assert');

require('../src/Global');

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');

const originalCache = SpotProfiles.cache;
SpotProfiles.cache = [
    {
        id: 'starter_human_01',
        avgLevel: 1,
        minLevel: 1,
        maxLevel: 3,
        density: 10,
        center: { locX: -84000, locY: 245000, locZ: -3729 }
    },
    {
        id: 'gear_source_01',
        avgLevel: 8,
        minLevel: 6,
        maxLevel: 10,
        density: 10,
        center: { locX: -110000, locY: 76000, locZ: -2800 }
    }
];

try {
    const equipmentPlan = {
        status: 'active',
        next: { spotId: 'gear_source_01' }
    };
    const atStarter = SpotProfiles.findForState({
        level: 1,
        spotId: 'starter_human_01',
        stats: { equipmentPlan, populationWave: 1, starterRegion: 'human' }
    });
    assert.strictEqual(atStarter.id, 'starter_human_01',
        'an active equipment plan must not replace a persisted physical starter spot');

    const unplaced = SpotProfiles.findForState({ level: 1, stats: { equipmentPlan } });
    assert.strictEqual(unplaced.id, 'gear_source_01',
        'a state without a physical spot may still select its equipment source');
} finally {
    SpotProfiles.cache = originalCache;
}

console.log('Spot profile state-priority checks passed');
