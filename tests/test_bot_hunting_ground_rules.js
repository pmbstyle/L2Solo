const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const BotTargetScorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const WorldAreaCatalog = invoke('GameServer/World/WorldAreaCatalog');
const BotHuntingGroundPolicy = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');

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
    assert.strictEqual(SpotProfiles.findForState({ level: 80, stats: {} }), null,
        'a bot without a level-aware candidate must report no spot instead of falling back to a starter field');
    assert.doesNotThrow(() => SpotService.isSuitable(mid, Infinity),
        'non-finite target levels must not create an unbounded eligibility scan');
    assert.strictEqual(SpotService.isSuitable(starter, 16), false,
        'starter mobs must not count as a suitable level-16 hunting ground');
    assert.strictEqual(SpotService.isSuitable(mid, 16), true,
        'a field with enough near-level mobs must remain suitable');

    const catacomb = {
        id: 'catacomb_cell',
        name: 'Catacomb of the Branded',
        minLevel: 52,
        maxLevel: 58,
        avgLevel: 55,
        density: 20,
        center: { locX: 140000, locY: -176000, locZ: -1000 },
        npcNames: ['Nephilim Guard'],
        tags: ['dungeon', 'catacomb'],
        tagsAuthoritative: true
    };
    const undergroundSector = WorldAreaCatalog.decorateSpot({
        id: '8_20',
        name: 'Generic surface fields',
        center: { locX: 0, locY: 0, locZ: 0 },
        arrivalPoints: [{ locX: 49705, locY: 123548, locZ: -5408 }]
    });
    assert.strictEqual(undergroundSector.area?.name, 'Necropolis of Pilgrims',
        'an underground spawn must classify a mixed grid sector even when its averaged center is outside the dungeon');
    assert.strictEqual(undergroundSector.tags?.includes('catacomb'), true,
        'Seven Signs sectors discovered through spawn points must carry the shared party-content tag');
    const partyAreas = [
        {
            name: 'Cruma Tower',
            point: { locX: 15342, locY: 111355, locZ: -12096 }
        },
        {
            name: 'Tower of Insolence',
            point: { locX: 113979, locY: 15956, locZ: -3608 }
        },
        {
            name: "Antharas' Lair",
            point: { locX: 140000, locY: 114000, locZ: -3696 }
        }
    ];
    partyAreas.forEach(({ name, point }, index) => {
        const decorated = WorldAreaCatalog.decorateSpot({
            id: `party_area_${index}`,
            name: 'Generic mob fields',
            center: { locX: 0, locY: 0, locZ: 0 },
            arrivalPoints: [point]
        });
        assert.strictEqual(decorated.area?.name, name,
            `${name} must be recognized from a real interior spawn point`);
        assert.strictEqual(decorated.tags?.includes('party_required'), true,
            `${name} must carry the shared party-content tag`);
        assert.strictEqual(BotHuntingGroundPolicy.evaluate(decorated, {
            level: decorated.area.id === 'cruma_tower' ? 44 : 70,
            activity: 'hunting',
            stats: {}
        }).allowed, false, `${name} must reject an ordinary solo hunter`);
        assert.strictEqual(BotHuntingGroundPolicy.evaluate(decorated, {
            level: decorated.area.id === 'cruma_tower' ? 44 : 70,
            activity: 'grouped',
            party: { partyId: `party_${index}` },
            stats: {}
        }).allowed, true, `${name} must remain available to a real party`);
    });
    const fullKit = (rank) => [
        { equipped: true, kind: 'Weapon.Sword', rank, slot: 7 },
        { equipped: true, kind: 'Armor.Wear', rank, slot: 6 },
        { equipped: true, kind: 'Armor.Wear', rank, slot: 9 },
        { equipped: true, kind: 'Armor.Chain', rank, slot: 10 },
        { equipped: true, kind: 'Armor.Chain', rank, slot: 11 }
    ];
    const crumaGround = {
        id: 'cruma_tower_room',
        name: 'Cruma Tower',
        minLevel: 40,
        maxLevel: 50,
        tags: ['dungeon', 'tower', 'construct', 'party_required']
    };
    assert.strictEqual(BotHuntingGroundPolicy.evaluate(crumaGround, {
        level: 40,
        stats: { equipment: fullKit('c').map(({ equipped, ...item }) => item) }
    }).allowed, true, 'a level-40 cold solo hunter in a complete C-grade kit may enter Cruma');
    assert.strictEqual(BotHuntingGroundPolicy.evaluate(crumaGround, { level: 39 }, {
        equipment: fullKit('c')
    }).allowed, false, 'Cruma solo entry must still require the level of its first-floor mobs');
    assert.strictEqual(BotHuntingGroundPolicy.evaluate(crumaGround, { level: 40 }, {
        equipment: fullKit('d')
    }).allowed, false, 'Cruma solo entry must reject a complete D-grade kit');
    const towerGround = {
        id: 'tower_of_insolence_room',
        name: 'Tower of Insolence',
        minLevel: 61,
        maxLevel: 75,
        tags: ['dungeon', 'tower', 'party_required', 'deep_party']
    };
    assert.strictEqual(BotHuntingGroundPolicy.evaluate(towerGround, { level: 61 }, {
        equipment: fullKit('b')
    }).allowed, true, 'Tower of Insolence solo entry must allow a complete B-grade kit');
    assert.strictEqual(BotHuntingGroundPolicy.evaluate(towerGround, { level: 61 }, {
        equipment: fullKit('c')
    }).allowed, false, 'Tower of Insolence solo entry must reject C-grade gear');
    const antharasGround = {
        id: 'antharas_lair_room',
        name: "Antharas' Lair",
        minLevel: 61,
        maxLevel: 75,
        tags: ['dungeon', 'lair', 'dvc', 'party_required', 'deep_party']
    };
    assert.strictEqual(BotHuntingGroundPolicy.evaluate(antharasGround, { level: 61 }, {
        equipment: fullKit('a')
    }).allowed, true, 'Antharas Lair solo entry must allow a complete A-grade kit');
    assert.strictEqual(BotHuntingGroundPolicy.evaluate(antharasGround, { level: 61 }, {
        equipment: fullKit('b')
    }).allowed, false, 'Antharas Lair solo entry must reject B-grade gear');
    const safeField = {
        id: 'safe_field',
        name: 'Ordinary level 55 field',
        minLevel: 52,
        maxLevel: 58,
        avgLevel: 55,
        density: 12,
        center: { locX: 150000, locY: -176000, locZ: -1000 },
        npcNames: ['Field Hunter'],
        tags: ['field'],
        tagsAuthoritative: true
    };
    SpotProfiles.cache = [catacomb, safeField];
    SpotService.findCurrentSpot = () => catacomb;
    const soloEscape = SpotProfiles.findForState({
        characterId: 200,
        level: 55,
        activity: 'hunting',
        spotId: catacomb.id,
        loc: catacomb.center,
        stats: { role: 'dps' }
    }, { occupancy: {} });
    assert.strictEqual(soloEscape.id, safeField.id,
        'cold routing must move an ordinary solo bot out of a catacomb');
    const partyStay = SpotProfiles.findForState({
        characterId: 201,
        level: 55,
        activity: 'grouped',
        spotId: catacomb.id,
        loc: catacomb.center,
        party: { partyId: 'bgp_catacomb', role: 'dps' },
        stats: { role: 'dps', routeMode: 'party' }
    }, { occupancy: {}, mode: 'party' });
    assert.strictEqual(partyStay.id, catacomb.id,
        'a real party must retain access to its catacomb hunting ground');

    SpotProfiles.cache = [starter, mid];
    SpotService.findCurrentSpot = () => starter;
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

    const blockedCatacombFight = BackgroundResolver.resolveSolo({
        state: {
            name: 'unsafe solo hunter',
            level: 55,
            activity: 'hunting',
            vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
            stats: { role: 'dps', classId: 1 }
        },
        spot: {
            id: 'catacomb_cell',
            name: 'Catacomb of the Branded',
            minLevel: 52,
            maxLevel: 58,
            avgLevel: 55,
            density: 20
        },
        elapsedMs: 60000,
        timestamp: startedAt
    });
    assert.strictEqual(blockedCatacombFight.debug.reason, 'party_required_hunting_ground');
    assert.strictEqual(blockedCatacombFight.debug.fights, 0,
        'cold solo resolution must never bypass the catacomb party gate');

    const blockedBeforeTravel = BackgroundResolver.resolveSolo({
        state: {
            name: 'unmoved solo hunter',
            level: 55,
            activity: 'hunting',
            spotId: 'catacomb_cell',
            currentRegion: 'Catacomb of the Branded',
            vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
            stats: { role: 'dps', classId: 1 }
        },
        spot: safeField,
        elapsedMs: 60000,
        timestamp: startedAt
    });
    assert.strictEqual(blockedBeforeTravel.debug.reason, 'party_required_hunting_ground');
    assert.strictEqual(blockedBeforeTravel.debug.fights, 0,
        'a safe planned destination must not resolve fights before the bot leaves its dangerous current ground');
    assert.strictEqual(blockedCatacombFight.materialize.exp, 0,
        'a blocked solo catacomb resolve must not award simulated combat progress');
} finally {
    SpotProfiles.cache = originalCache;
    SpotService.findCurrentSpot = originalFindCurrentSpot;
}

console.log('Bot hunting-ground rule checks passed');
