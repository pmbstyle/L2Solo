const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

// NPC_C4 is Lisvus' shared label for C4 additions. Its other monsters are the
// Swamp of Screams stakatos (c4_swamp_of_screams), Gremlin, Raikel and Corpse
// of Deadman (old datapack or not high-level) and the Fenril Hound and Ixion
// packs near the Forge of the Gods, which stay out: boss-like monsters
// (256k-515k HP, Valakas amulet drops) on a 60-second respawn (user, 2026-10-05).
const swampOfScreamsIds = [1508, 1509, 1510, 1511, 1512, 1513, 1514, 1515, 1516, 1517, 1518];
const fenrilPackIds = [13122, 13123, 13124, 13128, 13129, 13130, 13131, 13132, 13133, 13134, 13135];

const result = generateC4MonsterLocation({
    slug: 'c4_beast_farm',
    sourceLabel: 'NPC_C4',
    skippedMobIds: [...swampOfScreamsIds, 5198, 12170, 12789, ...fenrilPackIds],
    displayName: 'Beast Farm',
    areaId: 'c4-beast-farm',
    mobIds: [1443, 1444, 1445, 1446, 1447, 1448, 1449, 1450],
    spawnRows: 59,
    respawn: 60,
    skillRows: 17,
    dropRows: 119,
    missingItemIds: []
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
