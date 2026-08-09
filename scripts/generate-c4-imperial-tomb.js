const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const levels = (mp, power = []) => mp.map((value, index) => ({ level: index + 1, power: Number(power[index] || 0), mp: value, hp: 0, itemId: 0, itemCount: 0 }));
const active = (selfId, name, mp, power = [], options = {}) => ({
    selfId,
    template: { name, passive: false, spell: options.spell === true, distance: options.distance ?? 40 },
    time: { hitTime: options.hitTime || 0, reuse: options.reuse || 0, buff: options.buff || 0 },
    levels: levels(mp, power)
});
const mpEruption = [13, 20, 27, 35, 45, 55, 65, 69, 73, 75, 77, 78];
const eruptionPower = [37, 39, 41, 43, 45, 46, 48, 50, 51, 53, 54, 56];

const result = generateC4MonsterLocation({
    slug: 'c4_imperial_tomb', sourcePrefixes: ['godard14_2515_'], displayName: 'Imperial Tomb', areaId: 'c4-imperial-tomb',
    mobIds: [1396, 1397, 1398, 1399, 1400, 1401, 1402, 1403, 1404, 1405, 1406, 1407, 1408, 1410, 1411, 1412, 1413, 1414, 1415, 1416, 1417, 1418, 1420, 1421, 1424, 1425, 1426, 1427, 1428, 1429, 1430, 1431, 1432, 1434, 1798, 1799, 1800],
    spawnRows: 332, respawn: 40,
    respawnByMob: { 1396:60,1397:60,1398:30,1399:180,1400:45,1402:45,1403:90,1408:45,1410:60,1411:60,1412:80,1413:80,1414:45,1415:45,1418:45,1420:80,1421:80,1425:90,1426:30,1427:60,1428:60,1429:90,1430:90,1431:120,1434:720,1798:90,1799:90,1800:90 },
    skillRows: 339, dropRows: 520, missingItemIds: [],
    skillTemplates: [
        { selfId: 4233, template: { name: 'Vampiric Attack', passive: true, spell: false, distance: -1 }, time: { hitTime: 0, reuse: 0, buff: 0 }, levels: levels([0]) },
        active(4341, 'Ultimate Buff, 3rd', [50], [], { distance: -1, buff: 15000 }),
        active(4560, 'NPC Fire Burn', mpEruption, [13,15,18,20,23,26,29,32,35,38,42,44], { spell: true, distance: 150, hitTime: 1500, reuse: 6000 }),
        active(4565, 'NPC Eruption', mpEruption, eruptionPower, { spell: true, distance: 500, hitTime: 5000, reuse: 6000 }),
        active(4567, 'NPC Eruption - Slow', mpEruption, eruptionPower, { spell: true, distance: 500, hitTime: 5000, reuse: 6000 }),
        active(4577, 'Decrease Accuracy', [18,29,40,53,68,83,98,104,109,113,115,117], [], { spell: true, distance: 500, hitTime: 1500 }),
        active(4603, 'Decrease P.Atk', [24,39,53,70,90,110,130,138,145,150,153,155], [18,26,38,52,68,85,102,110,116,122,126,129], { spell: true, distance: 600, hitTime: 4000, buff: 15000 }),
        active(4665, 'NPC 100% HP Drain - Magic', [17,29,40,53,68,83,100,104,109,113,115,117], [12,18,25,35,46,57,68,73,78,81,84,86], { spell: true, distance: 600, hitTime: 2000 })
    ]
});
console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
