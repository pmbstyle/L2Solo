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
} finally { Table.best = best; }
console.log('PASS table roles of summoners and chanters, blessed spiritshot choice');
