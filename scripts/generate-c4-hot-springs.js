const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const diseaseLevels = Array.from({ length: 10 }, (_, index) => ({
    level: index + 1,
    power: 100,
    mp: 55,
    hp: 0,
    itemId: 0,
    itemCount: 0
}));

const disease = (selfId, name) => ({
    selfId,
    template: { name, passive: false, spell: true, distance: 600 },
    time: { hitTime: 0, reuse: 0, buff: 600000 },
    levels: diseaseLevels
});

const result = generateC4MonsterLocation({
    slug: 'c4_hot_springs',
    sourcePrefixes: ['godard05_2414_'],
    displayName: 'Hot Springs',
    areaId: 'c4-hot-springs',
    mobIds: [1314, 1315, 1316, 1317, 1318, 1319, 1320, 1321, 1322, 1323],
    spawnRows: 171,
    respawn: 70,
    skillRows: 119,
    dropRows: 129,
    missingItemIds: [7649, 7650, 7651, 7652, 7653],
    skillTemplates: [
        disease(4551, 'Hot Springs Rheumatism'),
        disease(4552, 'Hot Springs Cholera'),
        disease(4553, 'Hot Springs Flu'),
        disease(4554, 'Hot Springs Malaria'),
        {
            selfId: 4555,
            template: { name: 'NPC Resist Mutant', passive: false, spell: false, distance: -1 },
            time: { hitTime: 0, reuse: 0, buff: 0 },
            levels: [{ level: 1, power: 0, mp: 0, hp: 0, itemId: 0, itemCount: 0 }]
        }
    ]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
