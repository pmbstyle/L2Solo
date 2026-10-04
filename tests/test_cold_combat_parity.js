// Pins today's cold fight outcomes so the solo and party bot turns can share
// one implementation without changing any result: fixed-seed solo fights,
// fixed-seed party fights, a party of one against the solo fight, cold action
// delays and the clan raid estimate's cast cycle.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

// resolveFight and castCycle are module-private: compile a second copy of
// each file that also exports them.
function loadWith(file, extra) {
    const full = path.join(__dirname, '../src', file);
    const copy = new Module(full, module);
    copy.filename = full;
    copy.paths = Module._nodeModulePaths(path.dirname(full));
    copy._compile(fs.readFileSync(full, 'utf8') + extra, full);
    return copy.exports;
}
const resolveFight = loadWith('GameServer/Bot/Population/BackgroundResolver.js',
    '\nmodule.exports.__resolveFight = resolveFight;').__resolveFight;
const castCycle = loadWith('GameServer/Clan/ClanRaidEstimate.js',
    '\nmodule.exports.__castCycle = castCycle;').__castCycle;

const TS = 1_791_060_000_000;
function seeded(seed) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
// Physical damage spread draws from Math.random: seed it for the fight too.
function withSeed(seed, fn) {
    const realRandom = Math.random;
    Math.random = seeded(seed + 1000);
    try { return fn(seeded(seed)); } finally { Math.random = realRandom; }
}

// Synthetic fighters: class, level and the most expensive worn gear of the level's grade.
const RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
const rankFor = (level) => level >= 76 ? 's' : level >= 61 ? 'a' : level >= 52 ? 'b' : level >= 40 ? 'c' : level >= 20 ? 'd' : 'none';
const byPrice = (a, b) => Number(b.template?.price || 0) - Number(a.template?.price || 0);
function armorFor(kind, slot, rank) {
    for (let r = RANKS.indexOf(rank); r >= 0; r--) {
        const all = DataCache.items.filter((i) => i.template?.kind === kind && Number(i.etc?.slot) === slot && (i.etc?.rank || 'none') === RANKS[r]);
        if (all.length) return all.sort(byPrice)[0];
    }
    return null;
}
function weaponFor(kind, rank) {
    return DataCache.items.filter((i) => i.template?.kind === kind && (i.etc?.rank || 'none') === rank).sort(byPrice)[0] || null;
}
function fighter(id, classId, level, gear, extra = {}) {
    const rank = rankFor(level);
    const inventory = {};
    let n = 1;
    const put = (item, slot) => { if (item) inventory[n++] = { selfId: item.selfId, amount: 1, equipped: true, slot, equippedSlots: [slot] }; };
    put(weaponFor(gear.weapon, rank), 7);
    if (gear.chest) put(armorFor(gear.chest, 10, rank), 10);
    if (gear.legs) put(armorFor(gear.legs, 11, rank), 11);
    if (gear.full) put(armorFor(gear.full, 15, rank), 15);
    if (gear.shield) put(armorFor('Armor.Shield', 8, rank), 8);
    if (extra.potions) inventory[n++] = { selfId: 1061, amount: extra.potions };
    const state = { characterId: id, name: `Fighter${id}`, level, classId,
        stats: { classId, ...(extra.role ? { role: extra.role } : {}) }, inventory, vitals: {} };
    const profile = ColdCombatProfile.profileFor(state, TS);
    const hp = extra.hpRatio ? Math.round(profile.maxHp * extra.hpRatio) : profile.maxHp;
    return { ...state, vitals: { hp, mp: profile.maxMp } };
}
function spotFor(npcId) {
    const npc = DataCache.npcs.find((n) => n.selfId === npcId);
    const level = npc.template.level;
    return { id: 'parity', name: 'parity', avgLevel: level, minLevel: level, maxLevel: level, density: 12,
        npcEntries: [{ selfId: npcId, count: 1 }], npcSelfIds: [npcId],
        rewards: { exp: 1, sp: 1, adenaMin: 0, adenaMax: 0 }, center: { x: 0, y: 0, z: 0 } };
}

const robe = { weapon: 'Weapon.Blunt', chest: 'Armor.Fabric', legs: 'Armor.Fabric' };
const robeFull = { weapon: 'Weapon.Blunt', full: 'Armor.Fabric' };
const chain = (weapon) => ({ weapon, chest: 'Armor.Chain', legs: 'Armor.Chain' });
const leather = (weapon) => ({ weapon, chest: 'Armor.Leather', legs: 'Armor.Leather' });

const sorcerer = fighter(1001, 12, 60, robeFull, { potions: 5 });
const gladiator = fighter(1002, 2, 60, chain('Weapon.Dual'), { potions: 5 });
const bishop = fighter(1003, 16, 60, robe);
const warlock = fighter(1004, 14, 60, robe, { potions: 5 });
const necromancer = fighter(1005, 13, 60, robe);
const swordsinger = fighter(1006, 21, 60, chain('Weapon.Sword'));
const tyrant = fighter(1007, 48, 60, leather('Weapon.DualFist'), { potions: 5 });
const paladin = fighter(1008, 5, 60, { ...chain('Weapon.Sword'), shield: true }, { role: 'tank', potions: 5 });
const sorcerer40 = fighter(1009, 12, 40, robe);
const bladedancer = fighter(1010, 34, 60, chain('Weapon.Dual'));
const injuredBishop = fighter(1011, 16, 60, robe, { hpRatio: 0.5 });
const injuredTyrant = fighter(1012, 48, 60, leather('Weapon.DualFist'), { potions: 20, hpRatio: 0.25 });

// ---------- solo fights ----------
function soloOutcome(state, npcId, seed, fightLimitMs = 60000, maxActions = 400) {
    const r = withSeed(seed, (rng) => resolveFight({ state, spot: spotFor(npcId), pressure: {}, targetNpcId: npcId,
        rng, timestamp: TS, fightLimitMs, maxActions }));
    if (r.avoided) return { avoided: r.reason };
    return { won: r.won, died: r.died, hp: r.hp, mp: r.mp, charges: r.charges,
        actions: r.debug.actions, durationMs: Math.round(r.debug.durationMs), skillUses: r.debug.skillUses,
        shotActions: r.debug.shotActions, heals: r.debug.heals, musicUses: r.debug.musicUses,
        summonUses: r.debug.summonUses, summonActions: r.debug.summonActions, potionsUsed: r.debug.potionsUsed,
        mobHp: r.encounter ? Math.round(r.encounter.hp) : null,
        botReadyAt: r.encounter ? Math.round(r.encounter.botReadyAt) : null };
}
// [name, fighter, npc, seed, fight limit ms, action limit]
// Mobs re-picked when the C4 passive rules (robe sets, Final Fortress off at full HP)
// changed a fight from its scenario (the sorcerers won, warlock and paladin avoided the old mob).
const SOLO = [
    ['sorcerer dies after a self-heal', sorcerer, 241, 1],
    ['gladiator charges', gladiator, 5135, 2],
    ['bishop', bishop, 583, 3],
    ['warlock servitor, heals, potion', warlock, 239, 4],
    ['necromancer corpse servitor', necromancer, 129, 5],
    ['swordsinger songs', swordsinger, 129, 6],
    ['tyrant', tyrant, 5135, 7],
    ['paladin', paladin, 146, 8],
    ['sorcerer 40 dies', sorcerer40, 88, 9],
    ['bladedancer dances', bladedancer, 5135, 10],
    ['gladiator times out', gladiator, 5135, 14, 4000, 400],
    ['paladin runs out of actions', paladin, 122, 15, 60000, 10]
];
const SOLO_GOLDEN = {
    'sorcerer dies after a self-heal': { won: false, died: true, hp: 0, mp: 2365, charges: 0, actions: 24, durationMs: 23669, skillUses: 8, shotActions: 4, heals: 4, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 1, mobHp: null, botReadyAt: null },
    'gladiator charges': { won: true, died: false, hp: 1467, mp: 384, charges: 0, actions: 18, durationMs: 11315, skillUses: 10, shotActions: 6, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'bishop': { won: true, died: false, hp: 1031, mp: 2385, charges: 0, actions: 27, durationMs: 29256, skillUses: 9, shotActions: 7, heals: 2, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'warlock servitor, heals, potion': { won: true, died: false, hp: 176, mp: 2139, charges: 0, actions: 88, durationMs: 58312, skillUses: 14, shotActions: 0, heals: 14, musicUses: 0, summonUses: 1, summonActions: 37, potionsUsed: 1, mobHp: null, botReadyAt: null },
    'necromancer corpse servitor': { won: true, died: false, hp: 1150, mp: 2432, charges: 0, actions: 4, durationMs: 3442, skillUses: 2, shotActions: 2, heals: 0, musicUses: 0, summonUses: 1, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'swordsinger songs': { won: true, died: false, hp: 1221, mp: 13, charges: 0, actions: 29, durationMs: 22185, skillUses: 6, shotActions: 11, heals: 0, musicUses: 6, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'tyrant': { won: true, died: false, hp: 1840, mp: 691, charges: 0, actions: 7, durationMs: 3655, skillUses: 4, shotActions: 3, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'paladin': { won: true, died: false, hp: 1504, mp: 643, charges: 0, actions: 23, durationMs: 20867, skillUses: 8, shotActions: 9, heals: 1, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'sorcerer 40 dies': { won: false, died: true, hp: 0, mp: 1441, charges: 0, actions: 32, durationMs: 35504, skillUses: 10, shotActions: 2, heals: 8, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'bladedancer dances': { won: true, died: false, hp: 597, mp: 13, charges: 0, actions: 35, durationMs: 26083, skillUses: 6, shotActions: 13, heals: 0, musicUses: 6, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'gladiator times out': { won: false, died: false, hp: 1565, mp: 679, charges: 0, actions: 6, durationMs: 4000, skillUses: 3, shotActions: 2, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: 752, botReadyAt: 216 },
    'paladin runs out of actions': { won: false, died: false, hp: 1384, mp: 774, charges: 0, actions: 10, durationMs: 7518, skillUses: 2, shotActions: 5, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: 513, botReadyAt: 1127 }
};
for (const [name, state, npcId, seed, limitMs, maxActions] of SOLO) {
    assert.deepStrictEqual(soloOutcome(state, npcId, seed, limitMs, maxActions), SOLO_GOLDEN[name], `solo: ${name}`);
}

// ---------- party fights ----------
function partyOutcome(members, npcId, seed) {
    const r = withSeed(seed, (rng) => Resolver.resolvePartyFight({ members, spot: spotFor(npcId), targetNpcId: npcId, rng, timestamp: TS }));
    if (r.avoided) return { avoided: r.reason };
    return { won: r.won, actions: r.debug.actions, skillUses: r.debug.skillUses, musicUses: r.debug.musicUses,
        summonUses: r.debug.summonUses, summonActions: r.debug.summonActions, potionsUsed: r.debug.potionsUsed,
        mobHp: Math.round(r.debug.remainingHp), help: r.help.length,
        // characterId, hp, mp, actions, skill uses, shot actions, heals, songs, charges
        members: r.members.map((m) => [m.state.characterId, Math.round(m.vitals.hp), Math.round(m.vitals.mp),
            m.actions, m.skillUses, m.shotActions, m.heals, m.musicUses, m.charges]) };
}
const PARTY = [
    ['tank, charges, healer, songs, servitor', [paladin, gladiator, injuredBishop, swordsinger, warlock], 5135, 11],
    ['casters and a dancer', [sorcerer, necromancer, bishop, bladedancer], 7538, 12],
    ['injured with potions', [injuredTyrant, gladiator, sorcerer40], 7538, 13],
    ['necromancer corpse servitor', [necromancer, bishop], 129, 16]
];
const PARTY_GOLDEN = {
    'tank, charges, healer, songs, servitor': { won: true, actions: 25, skillUses: 18, musicUses: 5, summonUses: 1, summonActions: 0, potionsUsed: 0, mobHp: 0, help: 0,
        members: [[1008, 1338, 774, 4, 3, 3, 1, 0, 0],
            [1002, 1734, 497, 7, 7, 4, 0, 0, 0],
            [1011, 1290, 2565, 3, 3, 3, 0, 0, 0],
            [1006, 1392, 223, 5, 5, 0, 0, 5, 0],
            [1004, 1290, 2523, 1, 0, 0, 0, 0, 0]] },
    'casters and a dancer': { won: true, actions: 9, skillUses: 7, musicUses: 2, summonUses: 1, summonActions: 0, potionsUsed: 0, mobHp: 0, help: 0,
        members: [[1001, 1290, 2538, 2, 2, 2, 0, 0, 0],
            [1005, 1290, 2432, 2, 2, 2, 0, 0, 0],
            [1003, 1143, 2595, 1, 1, 1, 0, 0, 0],
            [1010, 1248, 673, 2, 2, 0, 0, 2, 0]] },
    'injured with potions': { won: true, actions: 20, skillUses: 15, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 1, mobHp: 0, help: 1,
        members: [[1012, 1340, 642, 7, 6, 4, 1, 0, 0],
            [1002, 1544, 578, 6, 6, 3, 0, 0, 1],
            [1009, 821, 1627, 3, 3, 0, 3, 0, 0]] },
    'necromancer corpse servitor': { won: true, actions: 5, skillUses: 3, musicUses: 0, summonUses: 1, summonActions: 0, potionsUsed: 0, mobHp: 0, help: 0,
        members: [[1005, 1290, 2432, 2, 2, 2, 0, 0, 0],
            [1003, 1208, 2595, 1, 1, 1, 0, 0, 0]] }
};
for (const [name, members, npcId, seed] of PARTY) {
    assert.deepStrictEqual(partyOutcome(members, npcId, seed), PARTY_GOLDEN[name], `party: ${name}`);
}

// ---------- a party of one fights exactly like the solo loop ----------
// Solo limits set to the party's (15 s, 96 actions); the tank role keeps the
// party's mob turn from drawing a random target among one member.
for (const [name, state, npcId, seed] of SOLO) {
    const member = { ...state, stats: { ...state.stats, role: 'tank' } };
    const solo = withSeed(seed, (rng) => resolveFight({ state: member, spot: spotFor(npcId), pressure: {}, targetNpcId: npcId,
        rng, timestamp: TS, fightLimitMs: 15000, maxActions: 96 }));
    const party = withSeed(seed, (rng) => Resolver.resolvePartyFight({ members: [member], spot: spotFor(npcId), targetNpcId: npcId, rng, timestamp: TS }));
    const m = party.members[0];
    assert.deepStrictEqual({
        won: party.won, died: m.vitals.hp <= 0, hp: Math.max(0, Math.round(m.vitals.hp)), mp: Math.max(0, Math.round(m.vitals.mp)),
        actions: party.debug.actions, skillUses: m.skillUses, shotActions: m.shotActions, heals: m.heals, musicUses: m.musicUses,
        summonUses: m.summonUses, summonActions: m.summonActions, potionsUsed: m.potionsUsed,
        mobHp: m.vitals.hp <= 0 ? null : Math.round(party.debug.remainingHp)
    }, {
        won: solo.won, died: solo.died, hp: solo.hp, mp: solo.mp,
        actions: solo.debug.actions, skillUses: solo.debug.skillUses, shotActions: solo.debug.shotActions, heals: solo.debug.heals,
        musicUses: solo.debug.musicUses, summonUses: solo.debug.summonUses, summonActions: solo.debug.summonActions,
        potionsUsed: solo.debug.potionsUsed,
        // a dead solo bot keeps no encounter, so its mob HP is unknown
        mobHp: solo.died ? null : solo.encounter ? Math.round(solo.encounter.hp) : 0
    }, `party of one = solo: ${name}`);
}

// ---------- action delays ----------
// rounded to 0.001 ms: the speed ratio leaves float noise (999.9999999999999)
const delay = (profile, skill) => Math.round(Resolver.combat.actionDelayMs(profile, skill) * 1000) / 1000;
const speeds = { castSpd: 333, atkSpd: 333 };
assert.strictEqual(delay(speeds, { spell: true, hitTime: 1000 }), 1000, 'spell: base 1000 ms at cast speed 333');
assert.strictEqual(delay(speeds, { spell: true, hitTime: 0 }), 1000, 'spell without a cast time: 1000 ms fallback');
assert.strictEqual(delay({ castSpd: 666, atkSpd: 333 }, { spell: true, hitTime: 2000 }), 1000, 'spell at double cast speed');
// C4 floor (L2Character.java:1458-1466): a skill with a base of at least 500 ms casts in no less than 500 ms;
// a shorter skill has no floor
assert.strictEqual(delay({ castSpd: 1332, atkSpd: 333 }, { spell: true, hitTime: 500 }), 500, 'spell: 500 ms floor');
assert.strictEqual(delay({ castSpd: 1332, atkSpd: 333 }, { spell: true, hitTime: 400 }), 100, 'spell under 500 ms: no floor');
assert.strictEqual(delay(speeds, { spell: false, hitTime: 0 }), 600, 'physical skill without a cast time: 600 ms fallback');
assert.strictEqual(delay({ castSpd: 333, atkSpd: 666 }, { spell: false, hitTime: 1200 }), 600, 'physical skill scales with attack speed');
assert.strictEqual(delay({ castSpd: 333, atkSpd: 333 }, { spell: false, hitTime: 300 }), 300, 'physical skill');
assert.strictEqual(delay({ castSpd: 333, atkSpd: 1332 }, { spell: false, hitTime: 600 }), 500, 'physical skill: 500 ms floor');
assert.strictEqual(delay({ castSpd: 333, atkSpd: 1332 }, { spell: false, hitTime: 400 }), 100, 'physical skill under 500 ms: no floor');
assert.strictEqual(delay({ castSpd: 1332, atkSpd: 333 }, { spell: true, hitTime: 0 }), 500, 'spell fallback 1000 ms keeps the 500 ms floor');
assert.strictEqual(delay(speeds), 1411.411, 'normal attack at attack speed 333');
assert.strictEqual(delay({ castSpd: 333, atkSpd: 2000 }), 250, 'normal attack: 250 ms floor (cold only; C4 has no attack-time floor)');

// ---------- magic critical rate in the cold profile ----------
// The cold profile stores the C4 rate once: base 8 x WIT bonus (a weapon is held) x magic-critical buffs.
const sorcererWit = Number(sorcererProfileFor().base.wit);
function sorcererProfileFor(effects = []) {
    return ColdCombatProfile.profileFor({ ...sorcerer, stats: { ...sorcerer.stats, coldCombat: { effects } } }, TS);
}
const plainSorcerer = sorcererProfileFor();
const Formulas = invoke('GameServer/Formulas');
assert.strictEqual(plainSorcerer.mCritRate, 8 * Formulas.calcBaseMod.WIT(Math.max(1, Math.round(sorcererWit))),
    'cold magic critical rate: 8 x WIT bonus with a weapon');
const wildMagic = { key: 'wild_magic', id: 1303, level: 2, type: 'buff', stats: { mCritRateMul: 4 }, expiresAt: TS + 60000 };
assert.strictEqual(sorcererProfileFor([wildMagic]).mCritRate, plainSorcerer.mCritRate * 4, 'Wild Magic quadruples the cold magic critical rate');
const focus = { key: 'focus', id: 1077, level: 3, type: 'buff', stats: { pCritRateMul: 1.3, pCritRateAdd: 100 }, expiresAt: TS + 60000 };
const focused = sorcererProfileFor([focus]);
assert.ok(focused.critical > plainSorcerer.critical, 'Focus raises the physical critical rate');
assert.strictEqual(focused.mCritRate, plainSorcerer.mCritRate, 'a physical critical buff does not change spell criticals');
const unarmed = ColdCombatProfile.profileFor({ ...sorcerer, inventory: {} }, TS);
assert.strictEqual(unarmed.mCritRate, 8, 'no weapon: the base 8 per mille');

// ---------- clan raid estimate cast cycle ----------
const sorcererProfile = ColdCombatProfile.profileFor(sorcerer, TS);
const SkillRules = invoke('GameServer/Skills/C4SkillRules');
const nuke = sorcererProfile.skills.find((skill) => !skill.passive && skill.spell !== false && Number(skill.power) > 0
    && SkillRules.resolve(skill).skillType === SkillRules.DAMAGE);
assert.strictEqual(nuke.selfId, 1177, 'the sorcerer nuke is Wind Strike');
assert.strictEqual(Math.round(castCycle(sorcererProfile, nuke) * 1000) / 1000, 3613.953,
    'raid estimate cast cycle of Wind Strike (a robe-set sorcerer has no robe-only cast speed penalty)');
assert.strictEqual(Math.round(castCycle({ castSpd: 333, atkSpd: 333, effects: [], skills: [] }, { spell: true, hitTime: 4000, reuse: 0 })), 4000,
    'raid estimate cast cycle: base cast time at cast speed 333');
assert.strictEqual(Math.round(castCycle({ castSpd: 1332, atkSpd: 333, effects: [], skills: [] }, { spell: true, hitTime: 1000, reuse: 0 })), 500,
    'raid estimate cast cycle: the C4 500 ms cast floor');

console.log('test_cold_combat_parity passed');
