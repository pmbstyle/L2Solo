const assert = require('assert');

require('../src/Global');
// Load native data before the first economic route or combat profile check.
invoke('GameServer/DataCache').init();

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotRoute = invoke('GameServer/Bot/Population/BotRoute');
// The one choice of a solo bot (BotRoute.huntSpot) over the test's catalogue.
const huntSpot = (state, timestamp = 1000) => BotRoute.huntSpot(state, null, { spots: SpotProfiles.cache, timestamp })?.spotId;

const originalCache = SpotProfiles.cache;
const originalBestSourceForPlan = GearAcquisitionPlanner.bestSourceForPlan;
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
    GearAcquisitionPlanner.bestSourceForPlan = () => ({ spotId: 'gear_source_01' });
    const atStarter = huntSpot({
        characterId: 10,
        level: 1,
        spotId: 'starter_human_01',
        stats: { equipmentPlan, populationWave: 1, starterRegion: 'human' }
    });
    assert.strictEqual(atStarter, 'starter_human_01',
        'an active equipment plan must not replace a persisted physical starter spot');

    const unplaced = huntSpot({ characterId: 11, level: 1, stats: { equipmentPlan } });
    assert.strictEqual(unplaced, 'gear_source_01',
        'a state without a physical spot may still select its equipment source');

    const dangerous = {
        id: 'dangerous_01', name: 'Dangerous field', avgLevel: 8, minLevel: 6, maxLevel: 10,
        density: 10, capacity: 10, center: { locX: 3000, locY: 3000, locZ: 0 }
    };
    const safer = {
        id: 'safer_01', name: 'Safer field', avgLevel: 8, minLevel: 6, maxLevel: 10,
        density: 9, capacity: 10, center: { locX: 4000, locY: 4000, locZ: 0 }
    };
    SpotProfiles.cache = [dangerous, safer];
    GearAcquisitionPlanner.bestSourceForPlan = (state, plan, profiles, options) => (
        options.excludedSpotIds.has(dangerous.id)
            ? { spotId: safer.id }
            : { spotId: dangerous.id }
    );
    const deathPressured = {
        characterId: 20,
        level: 8,
        spotId: dangerous.id,
        stats: {
            deaths: 2,
            fightsResolved: 6,
            spotRisk: { spotId: dangerous.id, deathsAtEntry: 0, fightsAtEntry: 0 },
            equipmentPlan: { status: 'active', strategy: 'direct_drop', target: { selfId: 1 }, next: { spotId: dangerous.id } }
        }
    };
    assert.strictEqual(
        huntSpot(deathPressured, 1000),
        safer.id,
        'death pressure must override an active equipment source and choose another available source'
    );
    const persistedBackoff = {
        ...deathPressured,
        spotId: safer.id,
        stats: {
            ...deathPressured.stats,
            spotRisk: { spotId: safer.id, deathsAtEntry: 2, fightsAtEntry: 6 },
            spotBackoffs: [{ spotId: dangerous.id, reason: 'death_pressure', startedAt: 1000, untilStep: 60 }]
        }
    };
    assert.strictEqual(
        huntSpot(persistedBackoff, 2000),
        safer.id,
        'a persisted backoff must stop the equipment plan from immediately pulling the bot back'
    );
    const expiredBackoff = { ...persistedBackoff, stats: { ...persistedBackoff.stats, stepCount: 60 } };
    assert.strictEqual(
        huntSpot(expiredBackoff, 5001),
        dangerous.id,
        'the original equipment source may be reconsidered after its cooldown expires'
    );

    const raid = {
        id: 'raid:999', name: 'Shared raid boss', avgLevel: 8, minLevel: 3, maxLevel: 10,
        density: 1, capacity: 999, raidBoss: true, raidBossTemplateId: 999,
        center: { locX: 5000, locY: 5000, locZ: 0 }
    };
    SpotProfiles.cache = [raid, safer];
    GearAcquisitionPlanner.bestSourceForPlan = originalBestSourceForPlan;
    assert.strictEqual(
        SpotProfiles.findForState({ characterId: 70, level: 8, spotId: raid.id }).id,
        safer.id,
        'an ordinary bot already placed on raid ground must evacuate to a normal hunting spot'
    );
} finally {
    SpotProfiles.cache = originalCache;
    GearAcquisitionPlanner.bestSourceForPlan = originalBestSourceForPlan;
}

console.log('Spot profile state-priority checks passed');
