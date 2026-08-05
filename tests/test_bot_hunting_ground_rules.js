const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const BotTargetScorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');

const originalCache = SpotProfiles.cache;
const originalFindCurrentSpot = SpotService.findCurrentSpot;

try {
    const starter = {
        id: 'starter_dwarf',
        name: 'Elder Longtail Keltir fields',
        minLevel: 1,
        maxLevel: 3,
        avgLevel: 2.1,
        density: 16,
        center: { locX: 115000, locY: -176000, locZ: -1000 },
        levelCounts: { 1: 3, 2: 8, 3: 5 }
    };
    const mid = {
        id: 'mid_level_field',
        name: 'Mid-level fields',
        minLevel: 12,
        maxLevel: 19,
        avgLevel: 15.5,
        density: 32,
        center: { locX: 125000, locY: -176000, locZ: -1000 },
        levelCounts: { 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4, 19: 4 }
    };

    SpotProfiles.cache = [starter, mid];
    SpotService.findCurrentSpot = () => starter;
    const selected = SpotProfiles.findForState({
        level: 16,
        spotId: 'remote_stale_destination',
        loc: starter.center,
        stats: {}
    });
    assert.strictEqual(selected.id, 'mid_level_field',
        'a level-16 bot must replan away from a physical level-1-3 starter field');
    assert.strictEqual(SpotService.isSuitable(starter, 16), false,
        'starter mobs must not count as a suitable level-16 hunting ground');
    assert.strictEqual(SpotService.isSuitable(mid, 16), true,
        'a field with enough near-level mobs must remain suitable');
    assert.strictEqual(
        LevelingRoutes.tagsForSpot({ minLevel: 10, maxLevel: 34, npcNames: ['Corpse Candle'] }).includes('starter'),
        false,
        'a mixed level-10-34 sector must not masquerade as a starter field'
    );

    const tooLow = BotTargetScorer.score({
        attackable: true,
        dead: false,
        botLevel: 16,
        npcLevel: 3,
        distance: 100,
        verticalGap: 0
    });
    assert.strictEqual(tooLow.eligible, false, 'voluntary targets seven-plus levels below the bot must be rejected');
    assert.strictEqual(tooLow.reason, 'level_too_low');
    const selfDefense = BotTargetScorer.score({
        attackable: true,
        dead: false,
        incomingThreat: true,
        botLevel: 16,
        npcLevel: 3,
        distance: 100,
        verticalGap: 0
    });
    assert.strictEqual(selfDefense.eligible, true, 'self-defense must remain possible against a weak incoming mob');

    DataCache.init();
    const duplicateSources = GearAcquisitionPlanner.sourceForItem(1864, [
        { id: 'gremlin_field_a', avgLevel: 2, npcEntries: [{ selfId: 1, name: 'Gremlin', count: 4 }] },
        { id: 'gremlin_field_b', avgLevel: 2, npcEntries: [{ selfId: 1, name: 'Gremlin', count: 4 }] },
        { id: 'gremlin_name_only', avgLevel: 2, npcEntries: [{ name: 'Gremlin', count: 4 }] }
    ], { level: 3 });
    assert.deepStrictEqual(
        new Set(duplicateSources.map((source) => source.spotId)),
        new Set(['gremlin_field_a', 'gremlin_field_b', 'gremlin_name_only']),
        'drop routing must retain every field containing the same dropper NPC'
    );

    const startedAt = 100000;
    const travelState = {
        name: 'leveling bot',
        activity: 'traveling',
        spotId: 'starter_dwarf',
        loc: { locX: 115000, locY: -176000, locZ: -1000 },
        stats: {
            travel: {
                from: { locX: 115000, locY: -176000, locZ: -1000 },
                to: { locX: 125000, locY: -176000, locZ: -1000 },
                startedAt,
                arrivalAt: startedAt + 25000,
                regionName: 'Mid-level fields',
                method: 'gatekeeper_spot',
                spotId: 'mid_level_field',
                arrivalActivity: 'hunting'
            }
        }
    };
    const midway = BackgroundResolver.resolveSolo({ state: travelState, spot: null, timestamp: startedAt + 1000 });
    assert.strictEqual(midway.patch.spotId, 'starter_dwarf', 'destination must not become current spot before arrival');
    assert.strictEqual(midway.materialize.exp, 0, 'cold travel must not simulate combat before arrival');
    const arrived = BackgroundResolver.resolveSolo({ state: travelState, spot: null, timestamp: startedAt + 25000 });
    assert.strictEqual(arrived.patch.spotId, 'mid_level_field', 'arrival must commit the destination spot');
    assert.strictEqual(arrived.patch.activity, 'hunting');
    assert.deepStrictEqual(arrived.patch.loc, { locX: 125000, locY: -176000, locZ: -1000 });
} finally {
    SpotProfiles.cache = originalCache;
    SpotService.findCurrentSpot = originalFindCurrentSpot;
}

console.log('Bot hunting-ground rule checks passed');
