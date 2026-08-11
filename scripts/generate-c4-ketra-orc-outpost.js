const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const levels = (mp, power = []) => mp.map((value, index) => ({
    level: index + 1,
    power: Number(power[index] || 0),
    mp: value,
    hp: 0,
    itemId: 0,
    itemCount: 0
}));

const active = (selfId, name, mp, { spell = false, distance = 40, hitTime = 0 } = {}) => ({
    selfId,
    template: { name, passive: false, spell, distance },
    time: { hitTime, reuse: 0, buff: 0 },
    levels: levels(mp)
});

const result = generateC4MonsterLocation({
    slug: 'c4_ketra_orc_outpost',
    sourceLabels: [
        'godard12_2415_01',
        'godard12_2415_02',
        'godard12_2415_03',
        'godard12_2415_04',
        'godard12_2415_08',
        'godard12_2415_09',
        'godard12_2415_12'
    ],
    displayName: 'Ketra Orc Outpost',
    areaId: 'c4-ketra-orc-outpost',
    mobIds: [
        1324, 1325, 1326, 1327, 1328, 1329, 1330, 1331, 1332, 1333, 1334,
        1335, 1336, 1337, 1338, 1339, 1340, 1341, 1342, 1343, 1345, 1347
    ],
    spawnRows: 761,
    respawn: 120,
    respawnByMob: { 1343: 100, 1345: 100, 1347: 100 },
    skillRows: 162,
    dropRows: 312,
    missingItemIds: [5167, 5533, 5545, 6672, 6689, 6693, 7668, 7669, 7670, 7671],
    skillTemplates: [
        active(4572, 'NPC Triple Sonic Slash', [27, 44, 62, 85, 109, 135, 157, 168, 177, 183, 187, 189], { hitTime: 1800 }),
        active(4575, 'NPC Clan Buff - Haste', [20, 49], { spell: true, distance: -1, hitTime: 2000 }),
        active(4576, 'NPC Clan Buff - Damage Shield', [15, 27, 49], { spell: true, distance: -1, hitTime: 2000 }),
        active(4578, 'Petrification', [73], { spell: true, distance: 600 }),
        active(4580, 'Decrease P.Atk', [25, 41, 57, 77, 100, 123, 143, 153, 161, 166, 170, 172], { hitTime: 1800 })
    ]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
