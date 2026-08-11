const assert = require('assert');

require('../src/Global');

const TownRespawn = invoke('GameServer/World/TownRespawn');
const BotAI = invoke('GameServer/Bot/BotAI');
const WorldAreaCatalog = invoke('GameServer/World/WorldAreaCatalog');
const C4SevenSignsDungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');

assert.strictEqual(
    WorldAreaCatalog.matches({ id: 'unconstrained_regression', name: 'Invalid catch-all' }, { locX: 0, locY: 0, locZ: 0 }),
    false,
    'an area without spatial constraints must not capture every world coordinate'
);

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(76000, 144000),
    { locX: 83446, locY: 147904, locZ: -3400 },
    'a player who dies near Giran should respawn beside the Giran gatekeeper'
);

assert.strictEqual(
    TownRespawn.getRegionGroup(49315, 248452, -5960),
    'ti_village',
    'the underground layer of cell 21_25 should resolve Elven Ruins to Talking Island'
);

const elvenRuins = WorldAreaCatalog.resolve({ locX: 45596, locY: 247589, locZ: -6518 });
assert.strictEqual(elvenRuins?.name, 'Elven Ruins', 'underground Elven Ruins coordinates must have a canonical game-area name');
assert.strictEqual(elvenRuins?.mapLayer, 'dungeon', 'Elven Ruins must not be projected onto the surface world map');
const decoratedElvenSpot = WorldAreaCatalog.decorateSpot({
    id: '7_41',
    name: 'Skeleton fields',
    center: { locX: 45596, locY: 247589, locZ: -6518 }
});
assert.strictEqual(decoratedElvenSpot.name, 'Elven Ruins', 'canonical area metadata must replace generated mob-field labels');
assert.strictEqual(decoratedElvenSpot.capacity, 64, 'Elven Ruins must carry its explicit population capacity');
assert.strictEqual(decoratedElvenSpot.tagsAuthoritative, true, 'area tags must override incidental mob-name tags');
assert.strictEqual(
    WorldAreaCatalog.resolve({ locX: 45596, locY: 247589, locZ: -3400 }),
    null,
    'the surface layer above Elven Ruins must not inherit the dungeon identity'
);

const mithrilMines = WorldAreaCatalog.resolve({ locX: 176673, locY: -177656, locZ: 801 });
assert.strictEqual(mithrilMines?.name, 'Mithril Mines', 'the detached mine spawn cell must have its canonical game-area name');
assert.strictEqual(mithrilMines?.mapLayer, 'dungeon', 'Mithril Mines must not be projected into the sea on the surface atlas');
const decoratedMithrilSpot = WorldAreaCatalog.decorateSpot({
    id: '29_-30',
    name: 'Akaste Bone Soldier fields',
    center: { locX: 176673, locY: -177656, locZ: 801 }
});
assert.strictEqual(decoratedMithrilSpot.name, 'Mithril Mines', 'mob-derived Akaste labels must be replaced by the canonical mine name');
assert.strictEqual(decoratedMithrilSpot.capacity, 48, 'Mithril Mines must carry a bounded per-sector population capacity');
assert.deepStrictEqual(decoratedMithrilSpot.localStarterRegions, ['dwarf'], 'the low-level mine route must remain local to dwarven starters');
assert.strictEqual(decoratedMithrilSpot.tagsAuthoritative, true, 'canonical mine tags must override incidental mob-name tags');
assert.strictEqual(
    WorldAreaCatalog.resolve({ locX: 175301, locY: -186816, locZ: -1360 }),
    null,
    'the northeast coast surface overlapping cell 25_12 must not inherit the Mithril Mines identity'
);

C4SevenSignsDungeonTeleports.DUNGEONS.forEach((dungeon) => {
    const [insideX, insideY, insideZ] = dungeon.outside.destination;
    const [outsideX, outsideY, outsideZ] = dungeon.outside.spawn;
    const area = WorldAreaCatalog.resolve({ locX: insideX, locY: insideY, locZ: insideZ });
    assert.strictEqual(area?.name, dungeon.name, `${dungeon.name} interior must resolve to its canonical area`);
    assert.ok(area?.tags.includes('catacomb'),
        `${dungeon.name} must retain the shared Seven Signs routing tag`);
    assert.strictEqual(area?.tags.includes('necropolis'), dungeon.name.startsWith('Necropolis'),
        `${dungeon.name} must retain the precise dungeon subtype`);
    assert.deepStrictEqual(
        WorldAreaCatalog.publicArea(area).mapAnchor,
        { locX: outsideX, locY: outsideY, locZ: outsideZ },
        `${dungeon.name} must project to its authoritative outside Gatekeeper Ziggurat`
    );
    assert.strictEqual(
        WorldAreaCatalog.resolve({ locX: outsideX, locY: outsideY, locZ: outsideZ }),
        null,
        `${dungeon.name} outside entrance must remain on the surface layer`
    );
});

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(49315, 248452, -5960),
    { locX: -84058, locY: 244604, locZ: -3728 },
    'a player who dies inside Elven Ruins should respawn beside the Talking Island gatekeeper'
);

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(49315, 248452, -3400),
    { locX: 83446, locY: 147904, locZ: -3400 },
    'the surface layer of the same map cell must continue to resolve to Giran'
);

const otherDungeonRoutes = [
    {
        name: 'Elven Fortress',
        loc: [29294, 74968, -3776],
        respawn: { locX: 46976, locY: 51511, locZ: -2976 }
    },
    {
        name: 'Cave of Trials',
        loc: [9340, -112509, -2536],
        respawn: { locX: -45214, locY: -112512, locZ: -256 }
    },
    {
        name: 'Abandoned Coal Mines',
        loc: [139714, -177456, -1536],
        respawn: { locX: 115122, locY: -178176, locZ: -880 }
    },
    {
        name: 'Mithril Mines',
        loc: [171946, -173352, 3448],
        respawn: { locX: 115122, locY: -178176, locZ: -880 }
    }
];
otherDungeonRoutes.forEach(({ name, loc, respawn }) => {
    assert.deepStrictEqual(
        TownRespawn.getRespawnCoords(...loc),
        respawn,
        `${name} should keep its native starter-village restart route`
    );
});

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(-82000, 151000),
    { locX: -80702, locY: 149776, locZ: -3040 },
    'a player who dies near Gludin should respawn beside the Gludin gatekeeper'
);

assert.deepStrictEqual(
    TownRespawn.getChaoticRespawnCoords(76000, 144000, () => 0),
    { locX: 74450, locY: 144238, locZ: -3730 },
    'a PK who dies near Giran must use the first sourced chaotic restart point, not the town gatekeeper'
);

assert.deepStrictEqual(
    TownRespawn.getChaoticRespawnCoords(49315, 248452, -5960, () => 0),
    { locX: -79411, locY: 240677, locZ: -3450 },
    'a PK who dies inside Elven Ruins should use a Talking Island chaotic restart point'
);

assert.deepStrictEqual(
    TownRespawn.getChaoticRespawnCoords(-12000, 122000, () => 0.99),
    { locX: -19040, locY: 121632, locZ: -3200 },
    'a PK who dies in the Gludio region must remain within Gludio chaotic restart points'
);

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(166612, 20436),
    { locX: 146787, locY: 25807, locZ: -2008 },
    'Cemetery belongs to the Aden restart region, not Oren'
);

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(146828, -12859),
    { locX: 146787, locY: 25807, locZ: -2008 },
    'Blazing Swamp belongs to the Aden restart region, not Oren'
);

assert.strictEqual(
    BotAI.getClosestTown(76000, 144000).name,
    'Giran',
    'bots should use the same nearest-town source as player respawns'
);

assert.strictEqual(
    BotAI.getClosestTown(49315, 248452, -5960).name,
    'Talking Island',
    'bots should use the same Z-aware Elven Ruins routing as players'
);

console.log('Town respawn regression checks passed');
