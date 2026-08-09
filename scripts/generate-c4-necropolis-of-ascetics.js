const generate = require('./lib/generate-c4-monster-location');

const result = generate({
    slug: 'c4_necropolis_of_ascetics',
    areaId: 'c4-necropolis-of-ascetics',
    sourceLabel: 'AsceticsNecropolis',
    displayName: 'Necropolis of Ascetics',
    mobIds: [1156, 1157, 1158, 1179, 1180, 1181, 1200, 1201, 1202, 1224, 1225, 1226],
    reusedMobIds: [1156, 1157, 1179, 1180, 1181, 1200, 1201, 1202],
    spawnRows: 184,
    respawn: 120,
    dropRows: 50,
    skillRows: 25,
    missingItemIds: [6350, 6352]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
