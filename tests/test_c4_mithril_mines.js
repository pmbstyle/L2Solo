const assert = require('assert');

require('../src/Global');

const C4ItemSkills = invoke('GameServer/Items/C4ItemSkills');
const DataCache = invoke('GameServer/DataCache');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');
const spawnAreas = require('../data/Npcs/Spawns/c4_mithril_mines.json');

assertC4MonsterLocation({
    slug: 'c4_mithril_mines',
    displayName: 'Mithril Mines',
    areaId: 'c4-mithril-mines',
    mobIds: [1136, 1137, 1138],
    importedNpcIds: [1136, 1137, 1138],
    bindingSlugs: ['c4_mithril_mines'],
    spawnCounts: [[1136, 51], [1137, 58], [1138, 57]],
    respawn: 40,
    region: [25, 12],
    maxHeightDelta: 11872,
    origin: [181000, -180000, -3500],
    sample: {
        id: 1136, name: 'Dead Pit Horror', level: 28, hostile: false,
        pAtk: 113, pDef: 110, mAtk: 49, mDef: 106, hp: 859,
        exp: 981, sp: 52, clan: 'undead_clan', race: 'undead'
    },
    sourceDropRows: 32,
    importedItems: {
        6387: 'Blessed Scroll of Resurrection for Pets'
    },
    importedSkillRows: 12,
    sourceSkillRows: 12,
    combatSkills: {
        1136: [],
        1137: [4250],
        1138: [4028]
    },
    multipliers: [
        { npcId: 1136, stat: 'holyVuln', value: 1.2 },
        { npcId: 1137, stat: 'bowWpnVuln', value: 0.3 },
        { npcId: 1137, stat: 'daggerWpnVuln', value: 0.7 },
        { npcId: 1137, stat: 'bluntWpnVuln', value: 1.1 }
    ]
});

const petResurrectionScroll = DataCache.items.find((item) => item.selfId === 6387);
assert.strictEqual(petResurrectionScroll.template.kind, 'Other.Scroll',
    'the sourced pet resurrection drop must remain a usable scroll');
assert.strictEqual(petResurrectionScroll.etc.consumable, true,
    'the sourced pet resurrection scroll must retain consumable item semantics');
assert.deepStrictEqual(C4ItemSkills.resolve(6387),
    { skillId: 2179, level: 1, consume: true, consumeAtStart: true },
    'the newly loaded drop must keep its existing C4 pet-resurrection behavior');

verifyGeodataWhenAvailable(GeodataEngine, [[25, 12]], 'Mithril Mines', () => {
    const coords = spawnAreas[0].spawns.flatMap((spawn) => spawn.coords);
    const heightDeltas = coords.map((coord) => Math.abs(
        GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
    ));
    assert.strictEqual(heightDeltas.filter((delta) => delta <= 32).length, 105,
        '105 authentic mine points must agree with the current geodata within 32 Z');
    assert.strictEqual(heightDeltas.filter((delta) => delta <= 128).length, 120,
        '120 authentic mine points must agree with the current geodata within 128 Z');
    assert.strictEqual(Math.max(...heightDeltas), 11872,
        'known missing lower mine layers must retain their audited maximum offset');
});
