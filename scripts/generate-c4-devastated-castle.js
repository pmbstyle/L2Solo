const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const passive = (selfId, name, levelCount) => ({
    selfId,
    template: { name, passive: true, spell: false, distance: -1 },
    time: { hitTime: 0, reuse: 0, buff: 0 },
    levels: Array.from({ length: levelCount }, (_, index) => ({
        level: index + 1, power: 0, mp: 0, hp: 0, itemId: 0, itemCount: 0
    }))
});

const result = generateC4MonsterLocation({
    slug: 'c4_devastated_castle',
    sourceLabel: 'aden26_2517_02',
    displayName: 'Devastated Castle',
    areaId: 'c4-devastated-castle',
    mobIds: [1004, 1005, 1006],
    spawnRows: 169,
    respawn: 75,
    skillRows: 17,
    dropRows: 51,
    missingItemIds: [4911, 4925, 4951],
    skillTemplates: [
        passive(4277, 'Resist Poison', 6),
        passive(4294, 'Race', 1)
    ]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
