const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const levels = (mp, power = []) => mp.map((value, index) => ({
    level: index + 1,
    power: Number(power[index] || 0),
    mp: value,
    hp: 0,
    itemId: 0,
    itemCount: 0
}));
const passive = (selfId, name, count) => ({
    selfId,
    template: { name, passive: true, spell: false, distance: -1 },
    time: { hitTime: 0, reuse: 0, buff: 0 },
    levels: levels(Array(count).fill(0))
});
const active = (selfId, name, mp, power, { spell = false, distance = 40, hitTime = 0, buff = 0 } = {}) => ({
    selfId,
    template: { name, passive: false, spell, distance },
    time: { hitTime, reuse: 0, buff },
    levels: levels(mp, power)
});

const result = generateC4MonsterLocation({
    slug: 'c4_wall_of_argos',
    sourcePrefixes: ['godard26_2516_'],
    displayName: 'Wall of Argos',
    areaId: 'c4-wall-of-argos',
    mobIds: [1294, 1295, 1296, 1297, 1298, 1299, 1300, 1301, 1302, 1303, 1304, 1305, 1306, 1307, 1308, 1309, 1310, 1311, 1312],
    spawnRows: 328,
    respawn: 60,
    respawnByMob: {
        1294: 55, 1295: 55, 1296: 100, 1297: 65, 1300: 75, 1301: 100,
        1304: 100, 1305: 75, 1306: 130, 1307: 100, 1308: 130, 1309: 130,
        1310: 100, 1311: 100, 1312: 340
    },
    skillRows: 143,
    dropRows: 266,
    missingItemIds: [],
    skillTemplates: [
        passive(4304, 'Strong Type', 1),
        passive(4306, 'Strong Type', 1),
        passive(4335, 'Sacred Attack', 1),
        passive(4337, 'Resist Sacred Attack', 6),
        active(4599, 'Decrease Speed', [37, 62, 86, 116, 149, 184, 215, 229, 241, 249, 255, 258], [], { distance: 40, hitTime: 1800 }),
        active(4609, 'NPC Clan Buff - Vampiric Rage', [15, 27, 42, 49], [], { spell: true, distance: -1, hitTime: 2000, buff: 120000 }),
        active(4613, 'NPC Clan Heal', [25, 44, 67, 92, 120, 147, 170, 182, 189, 194, 197, 197], [83, 151, 245, 362, 494, 627, 743, 789, 823, 845, 853, 853], { spell: true, distance: -1, hitTime: 2000 }),
        active(4657, 'Hold', [24, 39, 57, 70, 90, 110, 130, 138, 145, 150, 153, 155], [18, 26, 38, 52, 68, 85, 102, 110, 116, 122, 126, 129], { spell: true, distance: 600, hitTime: 4000, buff: 30000 })
    ]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
