'use strict';
// T106: summoners and orc chanters read table roles of their own; a
// spiritshot class takes Blessed Spiritshot when it holds it, or holds no
// spiritshot and the blessed rows' extra farm pays their extra cost
// (docs/game-decisions.md "Shots").
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');

for (const [classId, role] of [[14, 'summoner'], [41, 'summoner'], [96, 'summoner'], [12, 'mage'], [13, 'mage'],
    [52, 'chanter'], [49, 'chanter'], [17, 'buffer'], [21, 'buffer'], [2, 'dps']]) {
    assert.equal(Roles.tableRoleFor({ stats: { classId } }), role, `class ${classId}`);
}

const best = Table.best;
const blessedExp = new Map([[50, 200], [51, 151]]);
Table.best = (role, level, shots) => shots === 2 ? { exp: blessedExp.get(level), shots: 100, adena: 90000, loot: 10000 }
    : shots ? { exp: 150, shots: 100, adena: 90000, loot: 10000 } : { exp: 100, shots: 0, adena: 90000, loot: 10000 };
try {
    const sorcerer = (level, inventory = {}) => ({ level, stats: { classId: 12 }, inventory });
    // 50: blessed adds 1/2 - 1/3 of the farm for 100 x (45 - 18) a 100000 hour.
    assert.equal(Shots.planForState(sorcerer(50)).selfId, 3947, 'the blessed farm pays its cost');
    assert.equal(Shots.planForState(sorcerer(51)).selfId, 2509, 'a blessed farm that does not pay: spiritshot');
    assert.equal(Shots.planForState(sorcerer(50, { 2509: { selfId: 2509, amount: 5 } })).selfId, 2509,
        'held spiritshots are used first');
    assert.equal(Shots.planForState(sorcerer(51, { 3947: { selfId: 3947, amount: 5 } })).selfId, 3947,
        'held blessed ones are used');
    assert.equal(Shots.planForState(sorcerer(50), { blessed: false }).selfId, 2509, 'the table rows of spiritshot');
    assert.equal(Shots.planForState({ level: 50, stats: { classId: 2 }, inventory: {} }, { blessed: true }), null,
        'no blessed row for a soulshot class');
    // The plan follows each of its inputs: the blessed stock drunk in place (a
    // fight's own bag), a new bag with another weapon, the class on the same bag.
    const Data = invoke('GameServer/DataCache');
    const count = (selfId, kind) => Number(Data.items.find(item => Number(item?.selfId) === selfId)?.etc?.[kind] || 0);
    const worn = selfId => ({ selfId, amount: 1, equipped: true, slot: 7 });
    const bag = { 83: worn(83), 3948: { selfId: 3948, amount: 5 }, 2510: { selfId: 2510, amount: 5 } };
    const fighter = sorcerer(51, bag), shot = () => Shots.planForState(fighter);
    assert.deepEqual([shot().selfId, shot().perAction], [3948, count(83, 'spiritshot')], 'D weapon, blessed held');
    bag[3948].amount = 0;
    assert.equal(shot().selfId, 2510, 'blessed drunk in the same bag: its spiritshot');
    bag[2510].amount = 0;
    assert.equal(shot().selfId, 2510, 'neither held at 51: the blessed farm does not pay');
    fighter.level = 50;
    assert.equal(shot().selfId, 3948, 'at 50 it pays');
    fighter.inventory = { 72: worn(72) };
    assert.deepEqual([shot().selfId, shot().rank, shot().perAction], [3949, 'c', count(72, 'spiritshot')], 'a new bag with a C weapon');
    fighter.stats = { classId: 2 };
    assert.deepEqual([shot().selfId, shot().kind, shot().perAction], [1464, 'soulshot', count(72, 'soulshot')], 'a fighter class on the same bag');
    fighter.inventory = {};
    assert.deepEqual([shot().selfId, shot().perAction], [1835, 0], 'no weapon: no-grade, nothing per charge');
    // A worn row edited in place breaks the bag rule: developer diagnostics see it.
    const Config = invoke('GameServer/Bot/Population/PopulationConfig'), Failures = require('../src/FailureLog');
    const diagnostics = Config.developerDiagnostics, stale = () => Failures.snapshot()?.['kit_cache.stale'] || 0;
    const edited = { 72: worn(72) }, breaching = { level: 50, stats: { classId: 2 }, inventory: edited };
    assert.equal(Shots.planForState(breaching).selfId, 1464, 'fixture: C soulshots');
    try {
        Config.developerDiagnostics = true;
        const before = stale();
        edited[72] = { ...edited[72], equipped: false }; edited[83] = worn(83);
        assert.equal(Shots.planForState(breaching).selfId, 1463, 'the fresh answer under diagnostics');
        assert.equal(stale(), before + 1, 'the breach is counted');
    } finally { Config.developerDiagnostics = diagnostics; }
} finally { Table.best = best; }
console.log('PASS table roles of summoners and chanters, blessed spiritshot choice');
