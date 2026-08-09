const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_necropolis_of_martyrs',
    areaId: 'c4-necropolis-of-martyrs',
    sourceLabel: 'MartyrsNecropolis',
    displayName: 'Necropolis of Martyrs',
    mobIds: [1158, 1159, 1160, 1181, 1182, 1183, 1202, 1203, 1204, 1226, 1227, 1228],
    reusedMobIds: [1158, 1159, 1160, 1181, 1182, 1183, 1202, 1203, 1204, 1226, 1228],
    spawnRows: 128,
    respawn: 120,
    dropRows: 12,
    skillRows: 7,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
