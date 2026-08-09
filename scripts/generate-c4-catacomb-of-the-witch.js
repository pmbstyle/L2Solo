const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_catacomb_of_the_witch',
    areaId: 'c4-catacomb-of-the-witch',
    sourceLabel: 'CatacombOfTheWitch',
    displayName: 'Catacomb of the Witch',
    mobIds: [
        1156, 1157, 1159, 1160, 1179, 1180, 1181, 1182, 1183, 1200,
        1201, 1202, 1203, 1204, 1248, 1249, 1250, 1251, 1252
    ],
    spawnRows: 234,
    respawn: 120,
    dropRows: 343,
    skillRows: 147,
    missingItemIds: [5811, 5814, 5815]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
