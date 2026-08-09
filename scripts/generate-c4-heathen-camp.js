const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_heathen_camp',
    sourcePrefixes: ['godard31_2316_'],
    displayName: 'Heathen Camp',
    areaId: 'c4-heathen-camp',
    mobIds: [1438, 1439, 1440, 1441, 1442],
    spawnRows: 60,
    respawn: 37,
    sourcePeriod: 2,
    period: 'night',
    skillRows: 34,
    dropRows: 74,
    missingItemIds: [],
    skillTemplates: [{
        selfId: 4381,
        template: { name: 'Magic Skill Block', passive: false, spell: false, distance: -1 },
        time: { hitTime: 0, reuse: 8000, buff: 0 },
        levels: [{ level: 1, power: 0, mp: 0, hp: 0, itemId: 0, itemCount: 0 }]
    }]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
