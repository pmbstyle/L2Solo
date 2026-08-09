const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_catacomb_of_the_heretics',
    areaId: 'c4-catacomb-of-the-heretics',
    sourceLabel: 'HereticsCatacomb',
    displayName: 'Catacomb of the Heretics',
    mobIds: [1143, 1144, 1145, 1146, 1169, 1170, 1171, 1172,
        1190, 1191, 1192, 1193, 1236, 1237, 1238, 1239],
    reusedMobIds: [1144, 1145, 1146, 1169, 1170, 1171, 1172,
        1190, 1191, 1192, 1193],
    spawnRows: 244,
    respawn: 120,
    dropRows: 69,
    skillRows: 26,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
