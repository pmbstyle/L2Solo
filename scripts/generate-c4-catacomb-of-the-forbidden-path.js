const generate = require('./lib/generate-c4-monster-location');

const mobIds = [1163, 1164, 1165, 1185, 1186, 1206, 1207, 1254, 1255];
const result = generate({
    slug: 'c4_catacomb_of_the_forbidden_path',
    areaId: 'c4-catacomb-of-the-forbidden-path',
    sourceLabel: 'CatacombOfTheForbiddenPath',
    displayName: 'Catacomb of the Forbidden Path',
    mobIds,
    reusedMobIds: mobIds,
    spawnRows: 124,
    respawn: 60,
    dropRows: 0,
    skillRows: 0,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
