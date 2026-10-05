const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

// Marsh Stalker and Marsh Drake are already spawned by the old datapack.
const result = generateC4MonsterLocation({
    slug: 'c4_forsaken_plains',
    sourceLabels: ['aden22_2519_01', 'aden22_2519_09', 'aden22_2519_11', 'Forsaken Plains'],
    skippedMobIds: [679, 680],
    displayName: 'Forsaken Plains',
    areaId: 'c4-forsaken-plains',
    mobIds: [1017, 1018, 1019, 1020, 1021, 1022, 1258, 5316],
    spawnRows: 116,
    respawn: 27,
    respawnByMob: { 5316: 21600 },
    skillRows: 23,
    dropRows: 88,
    missingItemIds: [4915, 4921]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
