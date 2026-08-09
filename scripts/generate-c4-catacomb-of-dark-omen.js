const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_catacomb_of_dark_omen',
    areaId: 'c4-catacomb-of-dark-omen',
    sourceLabel: 'CatacombDarkOmen',
    displayName: 'Catacomb of Dark Omen',
    mobIds: [1162, 1163, 1165, 1184, 1185, 1186, 1205, 1206, 1207, 1253, 1254, 1255],
    reusedMobIds: [1162, 1163, 1165, 1184, 1185, 1186, 1205, 1206, 1207],
    spawnRows: 187,
    respawn: 120,
    dropRows: 43,
    skillRows: 17,
    missingItemIds: [7646, 7647, 7648, 7662, 7663, 7664]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
