const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

// Tairim, Taik Orc Seeker and Punishment of Undead are already spawned by the old datapack.
const result = generateC4MonsterLocation({
    slug: 'c4_cemetery',
    sourceLabels: ['aden09_2518_01', 'aden09_2518_09', 'aden09_2518_11'],
    skippedMobIds: [666, 675, 678],
    displayName: 'Cemetery',
    areaId: 'c4-cemetery',
    mobIds: [996, 997, 998, 999, 1000],
    spawnRows: 122,
    respawn: 30,
    skillRows: 27,
    dropRows: 88,
    missingItemIds: [5270]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
