const assert = require('assert');

require('../src/Global');

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

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

    const crowded = {
        id: 'crowded_01', name: 'Crowded field', avgLevel: 8, minLevel: 6, maxLevel: 10,
        density: 10, capacity: 2, center: { locX: 1000, locY: 1000, locZ: 0 }
    };
    const alternate = {
        id: 'alternate_01', name: 'Available field', avgLevel: 8, minLevel: 6, maxLevel: 10,
        density: 10, capacity: 10, center: { locX: 2000, locY: 2000, locZ: 0 }
    };
    SpotProfiles.cache = [crowded, alternate];
    const partyOne = { characterId: 1, level: 8, spotId: crowded.id, party: { partyId: 'party-a' } };
    const partyTwo = { characterId: 2, level: 8, spotId: crowded.id, party: { partyId: 'party-a' } };
    const surplusSolo = { characterId: 3, level: 8, spotId: crowded.id, party: {} };
    const surplusPartyOne = { characterId: 10, level: 8, spotId: crowded.id, party: { partyId: 'party-b' } };
    const surplusPartyTwo = { characterId: 11, level: 8, spotId: crowded.id, party: { partyId: 'party-b' } };
    const occupancy = SpotProfiles.occupancySnapshot(SpotProfiles.cache, [
        partyOne,
        partyTwo,
        surplusSolo,
        surplusPartyOne,
        surplusPartyTwo
    ]);
    assert.strictEqual(SpotProfiles.shouldLeaveOverCapacity(partyOne, crowded, occupancy), false,
        'the first whole party that fits within capacity must remain together');
    assert.strictEqual(SpotProfiles.shouldLeaveOverCapacity(partyTwo, crowded, occupancy), false,
        'retained background parties must never be split');
    assert.strictEqual(SpotProfiles.shouldLeaveOverCapacity(surplusPartyOne, crowded, occupancy), true,
        'a whole surplus party must be eligible for relocation');
    assert.strictEqual(SpotProfiles.shouldLeaveOverCapacity(surplusPartyTwo, crowded, occupancy), true,
        'all members of a surplus party must receive the same relocation decision');
    assert.strictEqual(SpotProfiles.shouldLeaveOverCapacity(surplusSolo, crowded, occupancy), true,
        'surplus solo hunters must be selected for deterministic redistribution');
    assert.strictEqual(
        SpotProfiles.findForState(surplusSolo, { occupancy }).id,
        alternate.id,
        'a surplus solo hunter must route to an available suitable field'
    );
    assert.strictEqual(
        SpotProfiles.findForState(surplusPartyOne, { occupancy }).id,
        alternate.id,
        'a surplus party leader must select another spot so the party can travel together'
    );

    const occupancyByPresence = SpotProfiles.occupancySnapshot(SpotProfiles.cache, [
        { characterId: 4, activity: 'merchant', spotId: crowded.id },
        { characterId: 5, activity: 'shopping', spotId: crowded.id },
        { characterId: 6, activity: 'crafting', spotId: crowded.id },
        { characterId: 7, activity: 'traveling', spotId: crowded.id, stats: { travel: { reason: 'market_sale_inventory' } } },
        { characterId: 8, activity: 'traveling', stats: { travel: { spotId: crowded.id, reason: 'return_after_market' } } },
        { characterId: 9, activity: 'hunting', spotId: crowded.id }
    ]);
    assert.strictEqual(occupancyByPresence[crowded.id].count, 2,
        'spot occupancy must include hunters and inbound travelers, not actors currently trading, crafting, or traveling to town');

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
            equipmentPlan: { status: 'active', strategy: 'direct_drop', target: { selfId: 1 } }
        }
    };
    assert.strictEqual(
        SpotProfiles.findForState(deathPressured, { occupancy: {}, timestamp: 1000 }).id,
        safer.id,
        'death pressure must override an active equipment source and choose another available source'
    );
    const persistedBackoff = {
        ...deathPressured,
        spotId: safer.id,
        stats: {
            ...deathPressured.stats,
            spotRisk: { spotId: safer.id, deathsAtEntry: 2, fightsAtEntry: 6 },
            spotBackoffs: [{ spotId: dangerous.id, reason: 'death_pressure', startedAt: 1000, until: 5000 }]
        }
    };
    assert.strictEqual(
        SpotProfiles.findForState(persistedBackoff, { occupancy: {}, timestamp: 2000 }).id,
        safer.id,
        'a persisted backoff must stop the equipment plan from immediately pulling the bot back'
    );
    assert.strictEqual(
        SpotProfiles.findForState(persistedBackoff, { occupancy: {}, timestamp: 5001 }).id,
        dangerous.id,
        'the original equipment source may be reconsidered after its cooldown expires'
    );
} finally {
    SpotProfiles.cache = originalCache;
    GearAcquisitionPlanner.bestSourceForPlan = originalBestSourceForPlan;
}

console.log('Spot profile state-priority checks passed');
