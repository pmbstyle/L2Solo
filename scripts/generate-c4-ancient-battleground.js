const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_ancient_battleground',
    sourceLabels: ['aden21_2317_08', 'aden21_2317_11', 'aden21_2317_14'],
    displayName: 'Ancient Battleground',
    areaId: 'c4-ancient-battleground',
    mobIds: [956, 959, 963],
    spawnRows: 74,
    respawn: 37,
    skillRows: 19,
    dropRows: 49,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
