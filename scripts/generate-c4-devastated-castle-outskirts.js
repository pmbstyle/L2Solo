const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

// The Doom monsters around the castle; the castle itself (aden26_2517_02) is
// c4_devastated_castle. Doom Knight is already spawned by the old datapack.
const result = generateC4MonsterLocation({
    slug: 'c4_devastated_castle_outskirts',
    sourceLabels: ['aden26_2517_01', 'aden26_2517_05', 'aden26_2517_12', 'aden26_2517_p01'],
    skippedMobIds: [674],
    displayName: 'Devastated Castle outskirts',
    areaId: 'c4-devastated-castle-outskirts',
    mobIds: [974, 1001, 1002, 1003, 1007, 1008, 1009, 1010],
    spawnRows: 261,
    respawn: 75,
    respawnByMob: { 974: 110 },
    skillRows: 44,
    dropRows: 128,
    missingItemIds: [5165]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
