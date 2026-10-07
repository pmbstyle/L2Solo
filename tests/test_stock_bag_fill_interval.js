'use strict';
const assert = require('node:assert/strict');
require('../src/Global'); invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const saved = { value: Table.value, best: Table.best, hunt: Hunt.huntIncome };
let stacks = 10, rowPresent = true, spotPresent = true;
const fixture = { characterId: 91819, level: 30, phase: 'hot', activity: 'hunting',
    stats: { classId: 1 }, vitals: { hp: 1000, mp: 1000 }, loc: {},
    inventory: { 1: { selfId: 1, amount: 40, stackable: false } } };
Hunt.huntIncome = () => ({ spotId: spotPresent ? 'stack-fixture' : null, perHour: 100000, expPerHour: 1000000 });
const row = withShots => ({ exp: withShots ? 1e6 : 5e5, shots: 1000, potions: 2, deaths: .1, stacks });
Table.value = (id, role, level, withShots) => rowPresent ? row(withShots) : null;
Table.best = () => row(true);
const target = (state = fixture) => Economy.basics(state, { spots: [] }).stock('potions').targetHours;
try {
    assert.equal(target(), 4, '80 slots - 40 physical non-stackables, 10 new slots/h -> 4h');
    stacks = 0; assert.equal(target(), 24, 'no new slots -> cap24h');
    stacks = null; assert.equal(target(), 2, 'old table without column -> 2h');
    stacks = 10; rowPresent = false; assert.equal(target(), 2, 'missing best-spot row -> 2h despite generic fallback table');
    rowPresent = true; spotPresent = false; assert.equal(target(), 2, 'no best spot -> 2h');
    spotPresent = true; stacks = 1000; assert.equal(target(), .5, 'full bag interval clamps to half an hour');
    assert.equal(target({ ...fixture, stats: { ...fixture.stats, visitEvery: [22, 4] } }), 4, 'observed visit interval wins');
    stacks = 10; assert.equal(target({ ...fixture, stats: { classId: 53 } }), 6, 'native dwarf class uses100-slot bag');
    assert.equal(target({ ...fixture, inventory: { 1864: { selfId: 1864, amount: 40, stackable: true } } }), 7.9,
        'stackable materials occupy one physical slot');
    console.log('test_stock_bag_fill_interval: ok');
} finally { Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.hunt; }
