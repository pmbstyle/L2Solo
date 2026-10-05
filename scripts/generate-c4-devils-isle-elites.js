const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

// The level 50-54 elite population of Devil's Isle; the base population is c4_devils_isle.
const result = generateC4MonsterLocation({
    slug: 'c4_devils_isle_elites',
    sourceLabels: ['giran08_2124_058', 'giran08_2124_065', 'giran08_2124_074', 'giran08_2124_082', 'giran08_2124_091'],
    displayName: "Devil's Isle elites",
    areaId: 'c4-devils-isle-elites',
    mobIds: [1625, 1628, 1631, 1634, 1637],
    spawnRows: 146,
    respawn: 180,
    skillRows: 40,
    dropRows: 85,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
