const assert = require('assert');

require('../src/Global');

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');
const spawnAreas = require('../data/Npcs/Spawns/c4_devastated_castle.json');

assertC4MonsterLocation({
    slug: 'c4_devastated_castle',
    displayName: 'Devastated Castle',
    areaId: 'c4-devastated-castle',
    mobIds: [1004, 1005, 1006],
    importedNpcIds: [1004, 1005, 1006],
    bindingSlugs: ['c4_devastated_castle'],
    spawnCounts: [[1004, 53], [1005, 60], [1006, 56]],
    respawn: 75,
    region: [25, 17],
    maxHeightDelta: 592,
    origin: [178000, -15000, -2800],
    sample: {
        id: 1004, name: 'Dismal Pole', level: 58, hostile: true,
        pAtk: 828, pDef: 384, mAtk: 428, mDef: 284, hp: 2889,
        exp: 5239, sp: 443, clan: 'undead_clan', race: 'plant'
    },
    sourceDropRows: 51,
    importedItems: {
        4911: 'Spellbook: Curse Disease',
        4925: "Amulet: Pa'agrio's Haste",
        4951: 'Recipe: Avadon Robe (60%)'
    },
    importedSkillRows: 17,
    sourceSkillRows: 17,
    combatSkills: {
        1004: [4028],
        1005: [4074],
        1006: [4034, 4100, 4002, 4038]
    },
    multipliers: [
        { npcId: 1004, stat: 'holyVuln', value: 1.2 },
        { npcId: 1004, stat: 'fireVuln', value: 1.15 },
        { npcId: 1004, stat: 'bowWpnVuln', value: 0.5 },
        { npcId: 1004, stat: 'poisonVuln', value: 0.5 },
        { npcId: 1006, stat: 'pCritDamageMul', value: 1.25 }
    ]
});

verifyGeodataWhenAvailable(GeodataEngine, [[25, 17]], 'Devastated Castle', () => {
    const coords = spawnAreas[0].spawns.flatMap((spawn) => spawn.coords);
    const heightDeltas = coords.map((coord) => Math.abs(
        GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
    ));
    assert.strictEqual(heightDeltas.filter((delta) => delta <= 32).length, 157,
        '157 authentic spawn points must agree with the current C4 geodata within 32 Z');
    assert.strictEqual(Math.max(...heightDeltas), 592,
        'the twelve audited Devastated Castle layer offsets must not drift beyond the known maximum');
});
