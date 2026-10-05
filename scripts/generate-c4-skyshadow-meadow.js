const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_skyshadow_meadow',
    sourceLabels: ['oren22_2219_p14', 'oren22_2219_p16', 'oren22_2219_p18'],
    displayName: 'Skyshadow Meadow',
    areaId: 'c4-skyshadow-meadow',
    mobIds: [947, 950, 953],
    spawnRows: 127,
    respawn: 33,
    skillRows: 12,
    dropRows: 41,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
