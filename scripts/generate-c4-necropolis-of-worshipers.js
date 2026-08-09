const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_necropolis_of_worshipers',
    areaId: 'c4-necropolis-of-worshipers',
    sourceLabel: 'WorshipersNecropolis',
    displayName: 'Necropolis of Worshipers',
    mobIds: [1147, 1148, 1149, 1174, 1175, 1176, 1195, 1196, 1197, 1217, 1218, 1219],
    reusedMobIds: [1147, 1149, 1174, 1175, 1176, 1195, 1196, 1197],
    spawnRows: 141,
    respawn: 60,
    dropRows: 47,
    skillRows: 22,
    missingItemIds: [5812, 5813]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
