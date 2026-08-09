const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_catacomb_of_the_apostate',
    areaId: 'c4-catacomb-of-the-apostate',
    sourceLabel: 'ApostateCatacomb',
    displayName: 'Catacomb of the Apostate',
    mobIds: [1152, 1153, 1154, 1155, 1176, 1177, 1178, 1179,
        1197, 1198, 1199, 1200, 1244, 1245, 1246, 1247],
    reusedMobIds: [1153, 1154, 1155, 1176, 1177, 1178, 1179,
        1197, 1198, 1199, 1200],
    spawnRows: 252,
    respawn: 60,
    dropRows: 81,
    skillRows: 27,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
