const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const levels = (mp, power = []) => mp.map((value, index) => ({
    level: index + 1, power: Number(power[index] || 0), mp: value,
    hp: 0, itemId: 0, itemCount: 0
}));
const passive = (selfId, name, count) => ({
    selfId, template: { name, passive: true, spell: false, distance: -1 },
    time: { hitTime: 0, reuse: 0, buff: 0 }, levels: levels(Array(count).fill(0))
});
const active = (selfId, name, mp, power = [], options = {}) => ({
    selfId,
    template: { name, passive: false, spell: options.spell === true, distance: options.distance ?? 40 },
    time: { hitTime: options.hitTime || 0, reuse: options.reuse || 0, buff: options.buff || 0 },
    levels: levels(mp, power)
});
const mp12 = {
    pdam: [27, 44, 62, 85, 109, 135, 157, 168, 177, 183, 187, 189],
    debuff: [25, 41, 57, 77, 100, 123, 143, 153, 161, 166, 170, 172],
    evasion: [13, 20, 27, 35, 45, 55, 65, 69, 73, 77, 78, 83],
    speed: [35, 58, 79, 105, 135, 165, 194, 207, 217, 224, 229, 233],
    pdef: [24, 39, 53, 70, 90, 110, 130, 138, 145, 150, 153, 155]
};

const result = generateC4MonsterLocation({
    slug: 'c4_forge_of_the_gods',
    sourcePrefixes: ['godard08_2514_', 'godard09_2514_'],
    displayName: 'Forge of the Gods',
    areaId: 'c4-forge-of-the-gods',
    mobIds: [1376, 1377, 1378, 1379, 1380, 1381, 1382, 1383, 1384, 1385, 1386, 1387, 1388, 1389, 1390, 1391, 1392, 1393, 1394, 1395, 1652, 1653, 1654, 1655, 1656, 1657],
    spawnRows: 423,
    respawn: 110,
    respawnByMob: { 1394: 90, 1395: 60 },
    skillRows: 202,
    dropRows: 379,
    missingItemIds: [],
    skillTemplates: [
        passive(4009, 'Resist Fire', 6),
        active(4229, 'NPC Double Wind Fist', mp12.pdam, [122, 279, 584, 1110, 1923, 3030, 4336, 5002, 5632, 6187, 6632, 6978], { distance: 700, hitTime: 4000, reuse: 17000 }),
        passive(4280, 'Water Attack Weak Point', 5),
        passive(4284, 'Resist Bleeding', 6),
        passive(4296, 'Race', 1),
        passive(4299, 'Race', 1),
        passive(4307, 'Strong Type', 1),
        active(4584, 'Reducing P.Def Shock', mp12.debuff, [], { hitTime: 1800 }),
        active(4586, 'Decrease Evasion', mp12.evasion, [], { spell: true, distance: 600, hitTime: 1500 }),
        active(4589, 'Decrease Speed', mp12.speed, [], { spell: true, distance: 500, hitTime: 4000 }),
        active(4591, 'Decrease Speed', mp12.speed, [], { spell: true, distance: 1000, hitTime: 2000 }),
        active(4594, 'Decrease P.Def', mp12.pdef, [], { spell: true, distance: 1000, hitTime: 2000 }),
        active(4595, 'NPC Clan Buff - Acumen Shield', [29, 53, 98], [], { spell: true, distance: -1, hitTime: 2000 }),
        active(4601, 'NPC Clan Buff - Acumen Focus', [29, 53, 98], [], { spell: true, distance: -1, hitTime: 2000, buff: 120000 }),
        active(4605, 'Fire Weakness', mp12.debuff, [46, 106, 219, 417, 722, 1136, 1626, 1876, 2112, 2320, 2487, 2617], { distance: 40, hitTime: 1800, buff: 15000 }),
        active(4607, 'Magma Attack', [78], [187], { spell: true, distance: 600, hitTime: 3000, reuse: 15000 })
    ]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
