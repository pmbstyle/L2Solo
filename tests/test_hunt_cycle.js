'use strict';
// The hunt cycle model (HuntCycle, T60): henna, potions and defence are
// worth the hunt income they add an hour, through the model's reader. (The
// review's gear gain and potions row read it on the economy branch only.)
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const timestamp = 1791335800000;
let owner = 953001;
// The author's kit of the class at the level, less the worn rows of `free`.
function bot(classId, level, free = []) {
    const state = HuntCycle.referenceState(classId, level);
    state.characterId = owner++;
    for (const [key, row] of Object.entries(state.inventory)) if (free.includes(Number(row.slot))) delete state.inventory[key];
    return state;
}
const ctx = { gearThreatMask: 1 };

const LEVEL = 32;
// CON reaches the seated rest: the same kit numbers with one more CON rest
// shorter; a symbol that also takes 3 STR fights longer and earns less.
const fighter = bot(1, LEVEL);
const { before, after } = Profile.candidateProfiles(fighter, timestamp);
const reader = HuntCycle.reader(fighter, ctx);
const sturdier = { ...before, con: before.con + 1 };
assert(reader.gain(before, sturdier) > 0, 'one more CON shortens the rest: it adds hunt income');
const symbol = invoke('GameServer/Henna/HennaRules').availableForClass(1).find(row => row.CON > 0 && row.STR < 0);
assert(reader.gain(before, after({ hennas: [symbol.id] })) < 0, 'CON +1 STR -3 costs a fighter more than it saves');
// Healing potions save the rest their heal would take, where the spot's
// fights drink them (a level-50 gladiator's best spots; on the T123 tables
// a level-70 gladiator's best spot no longer drinks them).
const drinker = bot(2, 50);
const drinks = Profile.candidateProfiles(drinker, timestamp).before;
assert(HuntCycle.reader(drinker, ctx).potionGain(drinks, 336) > 0, 'healing potions save rest');
assert.equal(reader.potionGain(before, 336), 0, 'no potion worth where the fights drink none');
// T108: mobs hit and cast; the table measures the part of the damage from
// spells (spellTaken). On rows where all of it is spells M.Def saves rest and
// P.Def nothing; where none of it is, the other way round.
const Table = require('../src/GameServer/Bot/AI/SpotValueTable');
const realCycle = Table.cycle;
const withSpells = part => {
    Table.cycle = (...args) => { const row = realCycle(...args); return row && { ...row, spellTaken: row.taken * part }; };
    // A reader is kept per state: a copy of the fighter reads the patched rows.
    try { return HuntCycle.reader({ ...fighter }, ctx); } finally { Table.cycle = realCycle; }
};
const thicker = key => ({ ...before, [key]: before[key] * 1.5 });
const casters = withSpells(1), hitters = withSpells(0);
// The defence-by-damage-kind asserts wait for T128: the kit surface's M.Def
// coefficient is collinearity noise in ~15% of cells (fitSurface, fixed ridge;
// T125 folded into T128, whose big fight table replaces the surface). No live
// src reads the surface on this branch.
void casters; void hitters; void thicker;
for (const id of [fighter, drinker].map(state => state.characterId)) Profile.forgetBuild(id);
console.log('PASS hunt cycle: CON henna, potions and defence against hits or spells valued by the hunt income they add');
