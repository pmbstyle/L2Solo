'use strict';
// Cold regeneration (T106, mage MP check): one tick is the hot rule's
// (Automation.fetchRevMpAmount): the level's base x level and MEN mods x the
// regMp multipliers, plus the regMpAdd adds, of the bot's own passives and
// buffs under its kit's conditions; x1.5 seated, x1.1 standing.
// C4 (Lisvus Formulas.java calcMpRegen, skills 214 Mana Recovery, 229 Fast
// Mana Recovery, 1297 Clear Mind): Wizard 24 seated 4.52, Sorcerer 50 seated
// 10.63, standing 11.31.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Rest = invoke('GameServer/Bot/Population/ColdRest');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');

const bot = (classId, level) => HuntCycle.referenceState(classId, level, { gear: invoke('GameServer/Bot/AI/BotGear'), profile: Profile });
const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 0.05, `${label}: ${actual} vs ${expected}`);

const wizard = bot(11, 24);
near(Rest.coldRestRegenPerTick(wizard).mp, 4.52, 'a Wizard in a robe sits with Mana Recovery');
const naked = { classId: 11, level: 24, stats: { classId: 11 } };
near(Rest.coldRestRegenPerTick(naked).mp, 4.52 / 1.2, 'no robe, no Mana Recovery');

const sorcerer = bot(12, 50);
const seated = Rest.coldRestRegenPerTick(sorcerer).mp, standing = Rest.coldRestRegenPerTick(sorcerer, { standing: true }).mp;
near(seated, 10.63, 'a Sorcerer seated: Clear Mind does not count');
near(standing, 11.31, 'a Sorcerer standing: x1.1 and Clear Mind');

// The resolver's hunt-time regeneration is the standing tick.
const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
const vitals = BR.applyStandingRegen({ ...sorcerer, vitals: { hp: 1, mp: 0 } }, { hp: 1, mp: 0 }, 30000, 0);
near(vitals.mp, standing * 10, 'ten standing ticks on the hunt');
// The rest's posture (user 10-29, RestPolicy.sitsToRest): a Sorcerer short
// of MP rests standing (Clear Mind), a Wizard sits; HP short, both sit.
const short = (state, hp, mp) => ({ ...state, vitals: { hp, mp } });
const sorcererRest = BR.resolveRest(short(sorcerer, 1e6, 0), 3000, 0);
assert.equal(sorcererRest.debug.regen.standing, true, 'a Sorcerer short of MP rests standing');
near(sorcererRest.debug.regen.mp, standing, 'at its standing tick');
assert.notEqual(BR.resolveRest(short(wizard, 1e6, 0), 3000, 0).debug.regen.standing, true, 'a Wizard sits');
const Policy = invoke('GameServer/Bot/AI/RestPolicy');
assert.equal(Policy.sitsToRest({ hp: 10, mp: 10 }, { hp: 5, mp: 11 }, 100, 100, true), true, 'HP short: sitting refills it first');
assert.equal(Policy.sitsToRest({ hp: 10, mp: 10 }, { hp: 5, mp: 11 }, 0, 100, true), false, 'only MP short: standing wins');
console.log('PASS cold regeneration by passives and the rest posture');
