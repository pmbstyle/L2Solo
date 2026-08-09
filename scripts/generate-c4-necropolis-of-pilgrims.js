const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_necropolis_of_pilgrims',
    areaId: 'c4-necropolis-of-pilgrims',
    sourceLabel: 'PilgrimsNecropolis',
    displayName: 'Necropolis of Pilgrims',
    mobIds: [1144, 1145, 1146, 1170, 1171, 1172, 1191, 1192, 1193, 1213, 1214, 1215],
    spawnRows: 176,
    respawn: 120,
    dropRows: 177,
    skillRows: 71,
    missingItemIds: [7638, 7639, 7640, 7643, 7644]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
