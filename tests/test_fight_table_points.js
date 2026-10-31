'use strict';
// The big fight table (T128): a kit's numbers come from a what-if over a
// list of worn items (ColdCombatProfile.candidateProfiles), equal to the
// whole kit's profile; a casting monster of the mob table deals a finite
// spell damage (ColdMobAction.actionMix reads its cast speed).
const assert = require('node:assert/strict');
const C = require('../scripts/hunt-tables/common');
C.boot();
const M = require('../scripts/hunt-tables/HuntModel');
const K = require('../scripts/hunt-tables/corrections');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Mob = invoke('GameServer/Bot/Population/ColdMobAction');

const KEY = '7>9', LEVEL = 25;
const BOW = { selfId: 280, slot: 14 };
const ARMOUR = [{ selfId: 394, slot: 10 }, { selfId: 416, slot: 11 }, { selfId: 2422, slot: 12 }]; // Reinforced Leather set
const row = item => ({ ...item, objectId: item.selfId, enchant: 0 });

const whole = M.profileOf(M.kitState(KEY, LEVEL, [BOW, ...ARMOUR]));
const { before, after } = Profile.candidateProfiles(M.kitState(KEY, LEVEL, []), 0);
const listed = after({ free: () => false, wear: [BOW, ...ARMOUR].map(row) });
for (const stat of ['pAtk', 'pDef', 'mDef', 'evasion', 'atkSpd']) {
    assert.equal(listed[stat], whole[stat], `a worn list gives the whole kit's ${stat}`);
}
assert.ok(listed.pDef > before.pDef, 'the listed armour is worn');
const one = after({ free: () => false, wear: row(BOW) });
assert.equal(one.pAtk, after({ free: () => false, wear: [row(BOW)] }).pAtk, 'one item or a list of one: the same');

// A swap on a kit of the same gear group keeps the formula path and its numbers.
const group = Profile.candidateProfiles(M.kitState(KEY, LEVEL, ARMOUR), 0).after;
assert.equal(group({ free: () => true, wear: ARMOUR.map(row) }).pDef, M.profileOf(M.kitState(KEY, LEVEL, ARMOUR)).pDef,
    'the group base re-wears its own kit');

const tables = { mobs: C.readTable('mobs') };
const casters = tables.mobs.mobs.map(mob => K.mobInput(tables, mob[0], 1))
    .filter(mob => Mob.coldMobFight(mob.combat).aiType === 'mage').slice(0, 20);
assert.ok(casters.length > 0, 'the mob table has casters');
for (const mob of casters) {
    const mix = Mob.actionMix(mob.combat, { profile: before }, 0, Mob.coldMobFight(mob.combat));
    assert.ok(Number.isFinite(mix.perSecond), `caster ${mob.combat.selfId} deals a finite damage`);
    assert.ok(mix.spellPerAction <= mix.perAction + 1e-9 && mix.spellSquarePerAction <= mix.squarePerAction + 1e-6,
        'the spell part is a part of the whole');
}
console.log('test_fight_table_points: ok');
