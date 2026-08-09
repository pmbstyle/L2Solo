const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_necropolis_of_the_disciples',
    areaId: 'c4-necropolis-of-the-disciples',
    sourceLabel: 'DisciplesNecropolis',
    displayName: 'Necropolis of the Disciples',
    mobIds: [
        1161, 1162, 1164, 1165, 1183, 1184, 1185, 1186,
        1204, 1205, 1206, 1207, 1228, 1229, 1230, 1231
    ],
    reusedMobIds: [1183, 1204],
    spawnRows: 225,
    respawn: 120,
    dropRows: 219,
    skillRows: 98,
    missingItemIds: [7645, 7665, 7666, 7667, 7672, 7673, 7674, 7675, 7676, 7835]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
