const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

// The first and second floor ghosts left out of c4_tower_of_insolence.
const result = generateC4MonsterLocation({
    slug: 'c4_tower_of_insolence_lower_floors',
    sourceLabel: 'aden33_2318_01',
    displayName: 'Tower of Insolence lower floors',
    areaId: 'c4-tower-of-insolence-lower-floors',
    mobIds: [809, 810, 811, 814],
    spawnRows: 64,
    respawn: 148,
    skillRows: 30,
    dropRows: 72,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
