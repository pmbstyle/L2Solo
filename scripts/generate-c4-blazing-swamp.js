const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_blazing_swamp',
    sourceLabels: ['aden03_2417_01', 'aden03_2417_11', 'aden03_2417_17'],
    displayName: 'Blazing Swamp',
    areaId: 'c4-blazing-swamp',
    mobIds: [1108, 1109, 1110, 1111, 1112, 1113, 1114, 1115, 1116],
    spawnRows: 349,
    respawn: 45,
    skillRows: 31,
    dropRows: 153,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
