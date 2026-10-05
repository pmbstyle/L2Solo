const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

// Single high-level monster families left in otherwise imported or old areas:
// Spirit of Timiniel (Enchanted Valley), Tanor Silenos Chieftain (Tanor Canyon),
// Doll Master and Garden Guard Leader (Garden of Eva), Ol Mahum Transcender
// (Outlaw Forest; Oel Mahum Warrior and Witch Doctor are already spawned by the old datapack).
const result = generateC4MonsterLocation({
    slug: 'c4_remaining_high_level_monsters',
    sourceLabels: ['aden08_mb2318_14', 'dion13_2122_04', 'innadrill05_2225_47', 'oren31_2217_01'],
    skippedMobIds: [575, 576],
    displayName: 'remaining high-level monsters',
    areaId: 'c4-remaining-high-level-monsters',
    mobIds: [803, 941, 994, 1261, 1797],
    spawnRows: 102,
    respawn: 94,
    respawnByMob: { 941: 45, 994: 110, 1261: 41, 1797: 80 },
    skillRows: 31,
    dropRows: 71,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
