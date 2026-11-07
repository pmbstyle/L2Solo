'use strict';
// T112/T113: the C4 shot multipliers of heals and blows (L2J C4 2006, Lisvus).
const assert = require('node:assert/strict');
require('../src/Global');
const Formulas = invoke('GameServer/Formulas');
assert.equal(Formulas.calcHealAmount(100), 100);
assert.equal(Formulas.calcHealAmount(100, { spiritshot: true }), 130, 'a spiritshot heals x1.3');
assert.equal(Formulas.calcHealAmount(100, { spiritshot: true, blessedSpiritshot: true }), 150, 'a blessed one x1.5');
const blow = soulshot => Formulas.calcBlowDamage(500, 0, 70, 1000, { soulshot, rng: () => 0 });
assert.equal(blow(false), 1500);
assert.equal(blow(true), 2000, 'a soulshot doubles P.Atk, not the skill power');
console.log('PASS C4 heal and blow shot multipliers');
