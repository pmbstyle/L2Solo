const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_necropolis_of_saints',
    areaId: 'c4-necropolis-of-saints',
    sourceLabel: 'SaintsNecropolis',
    displayName: 'Necropolis of Saints',
    mobIds: [1161, 1162, 1163, 1183, 1184, 1185, 1204, 1205, 1206, 1228, 1230, 1231],
    reusedMobIds: [1161, 1162, 1183, 1184, 1185, 1204, 1205, 1206, 1228, 1230, 1231],
    spawnRows: 197,
    respawn: 120,
    dropRows: 16,
    skillRows: 5,
    missingItemIds: [7654, 7655, 7660, 7661]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
