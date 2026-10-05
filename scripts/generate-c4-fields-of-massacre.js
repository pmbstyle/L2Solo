const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_fields_of_massacre',
    sourceLabels: ['aden23_2519_01', 'aden23_2519_02', 'aden07_2519_p01'],
    displayName: 'Fields of Massacre',
    areaId: 'c4-fields-of-massacre',
    mobIds: [966, 969, 973, 1058],
    spawnRows: 50,
    respawn: 37,
    respawnByMob: { 1058: 150 },
    skillRows: 20,
    dropRows: 64,
    missingItemIds: [7656, 7657, 7658, 7659]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
