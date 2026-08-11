const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const result = generateC4MonsterLocation({
    slug: 'c4_varka_silenos_stronghold',
    sourcePrefixes: ['godard28_2316_'],
    displayName: 'Varka Silenos Stronghold',
    areaId: 'c4-varka-silenos-stronghold',
    mobIds: [
        1350, 1351, 1352, 1353, 1354, 1355, 1356, 1357, 1358, 1359, 1360,
        1361, 1362, 1363, 1364, 1365, 1366, 1367, 1368, 1369, 1371, 1373
    ],
    spawnRows: 564,
    respawn: 109,
    respawnByMob: { 1369: 103, 1371: 103, 1373: 103 },
    skillRows: 166,
    dropRows: 297,
    missingItemIds: [],
    skillTemplates: [{
        selfId: 4562,
        template: { name: 'NPC Solar Flare', passive: false, spell: true, distance: 900 },
        time: { hitTime: 5000, reuse: 0, buff: 0 },
        levels: [15, 24, 33, 44, 57, 69, 82, 87, 90, 94, 97, 98].map((mp, index) => ({
            level: index + 1, power: 0, mp, hp: 0, itemId: 0, itemCount: 0
        }))
    }]
});

console.info(`Generated ${result.npcs} NPCs, ${result.spawns} spawns, ${result.drops} drops, ${result.skills} skills, ${result.skillTemplates} skill templates, ${result.items} items.`);
