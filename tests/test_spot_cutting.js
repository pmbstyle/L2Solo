'use strict';
// Spot cutting (T123, docs/game-decisions.md "Spot cutting"): the catalogue
// SpotService builds from the world's spawns splits a cell by floor, joins an
// edge fragment to the neighbour field of its species (its old id still finds
// that field), floors the area a few spawns cover, takes in the spawns of the
// other day period at their share of the day, and calls a spot near a level
// by its spawns' level mix.
const assert = require('node:assert/strict');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Npc = invoke('GameServer/Npc/Npc');
const World = invoke('GameServer/World/World');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const { SPOT_CELL_SIZE } = invoke('GameServer/World/WorldConstants');

// Two plain monsters of the 20s (any C4 field mob does).
const monsters = DataCache.npcs.filter(row => row.template?.kind === 'Monster' && !row.template?.raidBoss
    && row.template.level >= 20 && row.template.level <= 30).slice(0, 3).map(row => row.selfId);
assert.equal(monsters.length, 3, 'three field monsters in the datapack');
let nextId = 1;
const definition = (selfId, extra = {}) => ({ npc: DataCache.npcRow(selfId), spawn: { selfId, respawn: 60, ...extra }, bounds: [] });
const npcAt = (selfId, locX, locY, locZ, extra) => {
    const def = definition(selfId, extra);
    const npc = new Npc(nextId++, { ...utils.crushOb(def.npc), locX, locY, locZ });
    npc.spawnDefinition = def;
    return npc;
};
const cell = (gx, gy, dx, dy) => [gx * SPOT_CELL_SIZE + dx, gy * SPOT_CELL_SIZE + dy];
const [A, B, C] = monsters;
const spawns = [];
// Cell 10_10: a floor of five A at -3000 and one of four B at +2000.
for (let i = 0; i < 5; i++) spawns.push(npcAt(A, ...cell(10, 10, 1000 + i * 300, 3000), -3000));
for (let i = 0; i < 4; i++) spawns.push(npcAt(B, ...cell(10, 10, 1000 + i * 300, 3000), 2000));
// Cell 12_10: a field of six A at its east edge; 13_10: two A just across it.
for (let i = 0; i < 6; i++) spawns.push(npcAt(A, ...cell(12, 10, SPOT_CELL_SIZE - 900 + i * 100, 2000), 0));
spawns.push(npcAt(A, ...cell(13, 10, 200, 2000), 0), npcAt(A, ...cell(13, 10, 400, 2100), 0));
// Cell 20_10: three B on one line, 400 apart.
for (let i = 0; i < 3; i++) spawns.push(npcAt(B, ...cell(20, 10, 1000 + i * 400, 3000), 0));
// Cell 30_10: three C that spawn only at night, the world in day mode.
const [nx, ny] = cell(30, 10, 3000, 3000);
const night = [0, 1, 2].map(i => ({ ...definition(C, { period: 'night', coords: [{ locX: nx + i * 300, locY: ny, locZ: 0, head: 0 }] }) }));

const saved = World.npc;
World.npc = { spawns, periodMode: 'day', periodDefinitions: night };
SpotService.reset();
try {
    const spots = SpotService.ensureIndexed();
    const byId = id => spots.find(spot => spot.id === id);
    // Floors: the floor of the most spawns keeps the cell id; the other is :f2.
    assert.equal(byId('10_10')?.density, 5, 'the lower floor of five keeps the cell id');
    assert.equal(byId('10_10:f2')?.density, 4, 'the upper floor of four is its own spot');
    const [fx, fy] = cell(10, 10, 1500, 3000);
    assert.equal(SpotService.findCurrentSpot({ locX: fx, locY: fy, locZ: 1990 })?.id, '10_10:f2', 'a point on the upper floor');
    assert.equal(SpotService.findCurrentSpot({ locX: fx, locY: fy, locZ: -2990 })?.id, '10_10', 'a point on the lower floor');
    assert.equal(SpotService.containsLocation(byId('10_10:f2'), { locX: fx, locY: fy, locZ: -2990 }), false,
        'the upper floor does not hold the lower');
    // Fragments: 13_10's two A join the field across the edge; its id still finds it.
    assert.equal(byId('13_10'), undefined, 'the fragment is no spot of its own');
    assert.equal(byId('12_10')?.density, 8, 'the field takes the fragment in');
    assert.equal(SpotIndex.spotById(spots, '13_10')?.id, '12_10', 'a saved fragment id resolves to its field');
    const [gx, gy] = cell(13, 10, 300, 2000);
    assert.equal(SpotService.findCurrentSpot({ locX: gx, locY: gy, locZ: 0 })?.id, '12_10', 'standing in the fragment is standing on the field');
    // The area of three spawns on a line: at least 4 n d^2 (the walk between them is d).
    assert(byId('20_10')?.spawnArea >= 4 * 3 * 400 * 400, `a line of spawns covers an area: ${byId('20_10')?.spawnArea}`);
    // Night spawns: in the catalogue by day, producing a quarter of the game day.
    const nightSpot = byId('30_10');
    assert.equal(nightSpot?.density, 3, 'the night spawns are a spot by day');
    assert(Math.abs(nightSpot.npcEntries[0].production - 3 * 60 * 0.25) < 0.01, `night production over the day: ${nightSpot.npcEntries[0].production}`);
    assert.equal(World.npc.spawns.length, spawns.length, 'the night spawns are not added to the world');
} finally {
    World.npc = saved;
    SpotService.reset();
}

// Near level by the level mix: twenty 65s and one 76 are not near a 76.
const mixed = { id: 'mixed', minLevel: 65, maxLevel: 76, avgLevel: 65.5, density: 21, levelCounts: { 65: 20, 76: 1 } };
const catalog = [mixed];
assert.deepEqual(SpotProfiles.spotsNearLevel(catalog, 76), [], 'one high spawn does not make the field near');
assert.deepEqual(SpotProfiles.spotsNearLevel(catalog, 66), [mixed], 'the field is near its own level');
console.log('PASS spot cutting: floors, joined fragments, area floor, night spawns, near level by the mix');
