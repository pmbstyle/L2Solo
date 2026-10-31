'use strict';
// The spot table by C4 class lines (user 10-29): a bot reads the rows of its
// own class's line, a role name reads its alias line, and a line's spoil level is its
// class's learned Spoil.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');

const level = 50;
const key = (classId, at = level) => Table.roleFor({ level: at, stats: { classId } });
assert.equal(key(2), '2', 'a second class reads its own line');
assert.equal(key(88), '2', 'a third class reads its second\'s line');
assert.equal(key(46), '46', 'a Destroyer reads its own line, not the dps rows');
assert.equal(key(1, 30), '2', 'a Warrior reads its role\'s alias line, which holds it');
assert.equal(key(54, 30), '55', 'a Scavenger reads the Bounty Hunter line');
assert.equal(key(56, 30), '57', 'an Artisan reads the line that holds it');
assert.equal(Table.roleClass('dps', level), 2, 'a role name names its alias line\'s class');
assert.equal(Table.roleClass('3', 30), 1, 'a line below 40 is its first class');

assert(Table.roleSpoilLevel('55', level) > 0, 'the Bounty Hunter line spoils');
assert.equal(Table.roleSpoilLevel('spoiler', level), Table.roleSpoilLevel('55', level));
// The Dwarven Fighter learns Spoil 1 at 10 (data/Skills/Tree): the Warsmith keeps it, unlearned further.
assert.equal(Table.roleSpoilLevel('57', level), 1, 'the Warsmith line keeps the Dwarven Fighter\'s Spoil 1');
assert(Table.roleSpoilLevel('55', level) > 1, 'the Bounty Hunter line spoils at its own rank');

let checked = 0, differ = 0;
for (const spotId of Table.rankedSpotIds('dps', level, { shots: 0, potions: 0 })) {
    assert.deepEqual(Table.value(spotId, 'dps', level, true), Table.value(spotId, '2', level, true), 'an alias reads its line');
    const gladiator = Table.value(spotId, '2', level, true), destroyer = Table.value(spotId, '46', level, true);
    if (gladiator && destroyer && Math.round(gladiator.kills) !== Math.round(destroyer.kills)) differ++;
    if (++checked >= 10) break;
}
assert(checked > 0 && differ > 0, 'two lines of one role are measured apart');
console.log('PASS spot table class lines');
