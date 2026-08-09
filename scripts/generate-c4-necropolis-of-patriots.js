const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_necropolis_of_patriots',
    areaId: 'c4-necropolis-of-patriots',
    sourceLabel: 'PatriotsNecropolis',
    displayName: 'Necropolis of Patriots',
    mobIds: [1153, 1154, 1155, 1177, 1178, 1179, 1198, 1199, 1200, 1221, 1222, 1223],
    reusedMobIds: [1179, 1200],
    spawnRows: 188,
    respawn: 120,
    dropRows: 180,
    skillRows: 58,
    missingItemIds: [4944, 4965, 4968, 5003, 5280, 5809, 5810, 5816, 6351]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
