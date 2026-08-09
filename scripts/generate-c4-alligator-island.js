const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_alligator_island',
    sourcePrefixes: ['innadril13_2324_'],
    displayName: 'Alligator Island',
    areaId: 'c4-alligator-island',
    mobIds: [135, 791, 792],
    spawnRows: 137,
    respawn: 30,
    skillRows: 10,
    dropRows: 46,
    missingItemIds: [7641, 7642]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
