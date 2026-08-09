const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_shrine_of_loyalty',
    sourcePrefixes: ['godard27_2516_'],
    displayName: 'Shrine of Loyalty',
    areaId: 'c4-shrine-of-loyalty',
    mobIds: [1646, 1647, 1648, 1649, 1650, 1651],
    spawnRows: 52,
    respawn: 45,
    skillRows: 30,
    dropRows: 91,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
