const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

// Cave Beast and Death Wave share the first label and are already spawned by the old datapack.
const result = generateC4MonsterLocation({
    slug: 'c4_antharas_lair',
    sourceLabels: ['giran05_2421_01', 'giran05_2421_50', 'giran05_2421_53', 'giran05_2421_68', 'giran05_2421_75', 'giran05_2421_p50'],
    skippedMobIds: [620, 621],
    displayName: "Antharas' Lair",
    areaId: 'c4-antharas-lair',
    mobIds: [1084, 1085, 1086, 1087, 1088, 1089, 1090],
    spawnRows: 219,
    respawn: 300,
    respawnByMob: { 1084: 250, 1090: 400 },
    skillRows: 53,
    dropRows: 121,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
