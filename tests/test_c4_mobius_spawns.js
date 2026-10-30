const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');
const mobiusGroups = require('../data/Npcs/Spawns/c4_mobius_monsters.json');

DataCache.init();

const templates = new Map(DataCache.npcs.map((npc) => [Number(npc.selfId), npc]));
const isMobius = (area) => String(area.selfId).startsWith('mobius:');
const slotsOf = (row) => row.coords.length || row.total;

// The whole L2J_Mobius C4 monster population (scripts/generate-c4-mobius-spawns.js at its pinned revision).
const rows = mobiusGroups.flatMap((group) => group.spawns);
assert.strictEqual(mobiusGroups.length, 2761, 'every Mobius monster spawn group is ported');
assert.strictEqual(rows.reduce((sum, row) => sum + slotsOf(row), 0), 28533, 'every Mobius monster slot is ported');
assert.strictEqual(new Set(rows.map((row) => row.selfId)).size, 1204, 'every Mobius monster id is ported');

// Territory rows spawn `total` mobs inside a polygon; fixed rows hold one mob per coordinate.
mobiusGroups.forEach((group) => {
    group.spawns.forEach((row) => {
        if (row.coords.length > 0) {
            assert.strictEqual(row.total, 1, `${group.selfId}: a fixed row spawns one mob per point`);
            return;
        }
        assert.ok(group.bounds.length >= 3, `${group.selfId}: a territory row needs a polygon`);
        assert.ok(group.bounds.every((bound) => bound.minZ <= bound.maxZ), `${group.selfId}: territory Z range`);
    });
});

// Every spawned monster has a loaded template, and nothing outside Mobius places an ordinary monster
// or a monster Mobius already places (no double population).
const spawnedByMobius = new Set();
const spawnedElsewhere = new Map();
DataCache.npcSpawns.forEach((area) => area.spawns.forEach((row) => {
    const id = Number(row.selfId);
    if (isMobius(area)) spawnedByMobius.add(id);
    else spawnedElsewhere.set(id, area.selfId);
}));
assert.deepStrictEqual([...spawnedByMobius].filter((id) => !templates.has(id)), [], 'every Mobius monster has a template');
assert.deepStrictEqual([...spawnedByMobius].filter((id) => spawnedElsewhere.has(id)), [],
    'a Mobius monster is spawned only by Mobius');
assert.deepStrictEqual([...spawnedElsewhere.keys()].filter((id) => {
    const template = templates.get(id)?.template;
    return template?.kind === 'Monster' && template.raidBoss !== true;
}), [], 'ordinary monsters come only from Mobius');

// Mithril Mines holds its C4 population (players reported Abandoned Coal Mines mobs there).
const mithrilMines = DataCache.npcSpawns.find((area) => area.selfId === 'mobius:DwarvenTerritory/MithrilMines#MithrilMines');
assert.ok(mithrilMines, 'Mithril Mines is spawned');
const mithrilIds = new Set(mithrilMines.spawns.map((row) => Number(row.selfId)));
[1132, 1133, 1134, 1135, 1136, 1137, 1138, 1256].forEach((id) =>
    assert.ok(mithrilIds.has(id), `Mithril Mines spawns ${templates.get(id).template.name}`));

// Mobius points against our geodata (fixed points keep their file Z): the converter moves a point
// that is off every floor onto a floor only when the mob can walk to its group from there. Mithril
// Mines keeps 26 of its 511 points more than 300 Z off on the C4 client geodata (T49; 79 on the
// old pack). Pinned so a change shows.
const mithrilPoints = mithrilMines.spawns.flatMap((row) => row.coords);
const mithrilRegions = [...new Set(mithrilPoints.map((point) => GeodataEngine.getRegionKey(point.locX, point.locY)))]
    .map((key) => key.split('_').map(Number));
verifyGeodataWhenAvailable(GeodataEngine, mithrilRegions, 'Mithril Mines', () => {
    const off = mithrilPoints.filter((point) =>
        Math.abs(GeodataEngine.getHeight(point.locX, point.locY, point.locZ) - point.locZ) > 300);
    assert.strictEqual(off.length, 26, 'Mithril Mines points off the geodata');
});

// Pet quest monsters (Maille Lizardmen, Fairy Trees) come from Mobius too.
[919, 920, 921, 5185, 5186, 5187, 5188].forEach((id) =>
    assert.ok(spawnedByMobius.has(id), `pet quest monster ${id} is spawned by Mobius`));

// The monsters this server had no template for take Lisvus's (npc.sql row 794: Blade Stakato).
const stakato = templates.get(794);
assert.deepStrictEqual(
    { name: stakato.template.name, level: stakato.template.level, hostile: stakato.template.hostile,
        hp: stakato.vitals.maxHp, pAtk: stakato.stats.pAtk, pDef: stakato.stats.pDef,
        exp: Math.round(stakato.rewards.exp * stakato.template.level ** 2), sp: stakato.rewards.sp },
    { name: 'Blade Stakato', level: 41, hostile: false, hp: 1593, pAtk: 265, pDef: 229, exp: 2103, sp: 137 },
    'a Lisvus template keeps its source values');

console.log('C4 Mobius spawn port checks passed');
