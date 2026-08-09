const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_mithril_mines',
    sourceLabel: 'elmore_dwarf06_2512_68',
    displayName: 'Mithril Mines',
    areaId: 'c4-mithril-mines',
    mobIds: [1136, 1137, 1138],
    spawnRows: 166,
    respawn: 40,
    skillRows: 12,
    dropRows: 32,
    missingItemIds: [6387],
    itemOverrides: {
        6387: { kind: 'Other.Scroll', class2: 5, consumable: true }
    }
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.items} items.`);
