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
const ShotStock = invoke('GameServer/Inventory/ShotStock');

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
// Math.random is seeded too, so a draw outside the fight rng would still be reproducible.
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
    // The shot hot auto shots would load, keyed by its item id as in a real inventory summary.
    if (extra.shots) {
        const selfId = ShotStock.planForState(state).selfId;
        inventory[selfId] = { selfId, amount: extra.shots };
    }
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
// The same fighters holding the shot their weapon takes (S1).
const gladiatorShots = fighter(1013, 2, 60, chain('Weapon.Dual'), { potions: 5, shots: 5000 });
const sorcererShots = fighter(1014, 12, 60, robeFull, { potions: 5, shots: 5000 });
const bishopShots = fighter(1015, 16, 60, robe, { shots: 5000 });
const injuredBishopShots = fighter(1016, 16, 60, robe, { hpRatio: 0.5, shots: 5000 });
const paladinShots = fighter(1017, 5, 60, { ...chain('Weapon.Sword'), shield: true }, { role: 'tank', potions: 5, shots: 5000 });

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
    ['paladin runs out of actions', paladin, 122, 15, 60000, 10],
    ['gladiator charges with soulshots', gladiatorShots, 5135, 2],
    ['sorcerer with spiritshots', sorcererShots, 241, 1],
    ['bishop with spiritshots', bishopShots, 583, 3]
];
const SOLO_GOLDEN = {
    'sorcerer dies after a self-heal': { won: false, died: true, hp: 0, mp: 2365, charges: 0, actions: 24, durationMs: 23669, skillUses: 8, shotActions: 0, heals: 4, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 1, mobHp: null, botReadyAt: null },
    'gladiator charges': { won: true, died: false, hp: 1389, mp: 384, charges: 0, actions: 18, durationMs: 11315, skillUses: 10, shotActions: 0, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'bishop': { won: true, died: false, hp: 1014, mp: 2489, charges: 0, actions: 19, durationMs: 19877, skillUses: 7, shotActions: 0, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'warlock servitor, heals, potion': { won: true, died: false, hp: 345, mp: 2237, charges: 0, actions: 81, durationMs: 54630, skillUses: 12, shotActions: 0, heals: 12, musicUses: 0, summonUses: 1, summonActions: 34, potionsUsed: 1, mobHp: null, botReadyAt: null },
    'necromancer corpse servitor': { won: true, died: false, hp: 1140, mp: 2432, charges: 0, actions: 4, durationMs: 3442, skillUses: 2, shotActions: 0, heals: 0, musicUses: 0, summonUses: 1, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'swordsinger songs': { won: true, died: false, hp: 1141, mp: 13, charges: 0, actions: 33, durationMs: 24336, skillUses: 6, shotActions: 0, heals: 0, musicUses: 6, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'tyrant': { won: true, died: false, hp: 1717, mp: 691, charges: 0, actions: 7, durationMs: 3655, skillUses: 4, shotActions: 0, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'paladin': { won: true, died: false, hp: 1490, mp: 643, charges: 0, actions: 23, durationMs: 20867, skillUses: 8, shotActions: 0, heals: 1, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'sorcerer 40 dies': { won: false, died: true, hp: 0, mp: 1400, charges: 0, actions: 37, durationMs: 40576, skillUses: 12, shotActions: 0, heals: 10, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'bladedancer dances': { won: true, died: false, hp: 604, mp: 13, charges: 0, actions: 35, durationMs: 26083, skillUses: 6, shotActions: 0, heals: 0, musicUses: 6, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'gladiator times out': { won: false, died: false, hp: 1579, mp: 679, charges: 0, actions: 6, durationMs: 4000, skillUses: 3, shotActions: 0, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: 1306, botReadyAt: 216 },
    'paladin runs out of actions': { won: false, died: false, hp: 1398, mp: 774, charges: 0, actions: 10, durationMs: 7518, skillUses: 2, shotActions: 0, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: 534, botReadyAt: 1127 },
    'gladiator charges with soulshots': { won: true, died: false, hp: 1453, mp: 487, charges: 1, actions: 15, durationMs: 9165, skillUses: 8, shotActions: 5, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'sorcerer with spiritshots': { won: true, died: false, hp: 979, mp: 2464, charges: 0, actions: 7, durationMs: 4516, skillUses: 4, shotActions: 4, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null },
    'bishop with spiritshots': { won: true, died: false, hp: 1121, mp: 2542, charges: 0, actions: 14, durationMs: 11548, skillUses: 4, shotActions: 4, heals: 0, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: null, botReadyAt: null }
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
    ['necromancer corpse servitor', [necromancer, bishop], 129, 16],
    ['tank and healer with shots', [paladinShots, injuredBishopShots], 5135, 11]
];
const PARTY_GOLDEN = {
    'tank, charges, healer, songs, servitor': { won: true, actions: 25, skillUses: 18, musicUses: 5, summonUses: 1, summonActions: 0, potionsUsed: 0, mobHp: 0, help: 0,
        members: [[1008, 1340, 774, 4, 3, 0, 1, 0, 0],
            [1002, 1734, 497, 7, 7, 0, 0, 0, 0],
            [1011, 1290, 2565, 3, 3, 0, 0, 0, 0],
            [1006, 1392, 223, 5, 5, 0, 0, 5, 0],
            [1004, 1290, 2523, 1, 0, 0, 0, 0, 0]] },
    'casters and a dancer': { won: true, actions: 9, skillUses: 7, musicUses: 2, summonUses: 1, summonActions: 0, potionsUsed: 0, mobHp: 0, help: 0,
        members: [[1001, 1290, 2538, 2, 2, 0, 0, 0, 0],
            [1005, 1290, 2432, 2, 2, 0, 0, 0, 0],
            [1003, 1189, 2595, 1, 1, 0, 0, 0, 0],
            [1010, 1227, 673, 2, 2, 0, 0, 2, 0]] },
    'injured with potions': { won: true, actions: 12, skillUses: 9, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 1, mobHp: 0, help: 1,
        members: [[1012, 1326, 765, 5, 4, 0, 1, 0, 0],
            [1002, 1665, 679, 3, 3, 0, 0, 0, 0],
            [1009, 821, 1659, 2, 2, 0, 2, 0, 0]] },
    'necromancer corpse servitor': { won: true, actions: 5, skillUses: 3, musicUses: 0, summonUses: 1, summonActions: 0, potionsUsed: 0, mobHp: 0, help: 0,
        members: [[1005, 1290, 2432, 2, 2, 0, 0, 0, 0],
            [1003, 1165, 2595, 1, 1, 0, 0, 0, 0]] },
    'tank and healer with shots': { won: true, actions: 20, skillUses: 7, musicUses: 0, summonUses: 0, summonActions: 0, potionsUsed: 0, mobHp: 0, help: 0,
        members: [[1017, 1148, 774, 7, 3, 5, 1, 0, 0],
            [1016, 1290, 2542, 6, 4, 4, 0, 0, 0]] }
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

// ---------- solo start vitals and the physical damage spread ----------
// Stored HP / MP above the maximum start the solo fight at the maximum, as the party fight does.
const overfull = { ...gladiator, vitals: { hp: 999999, mp: 999999 } };
const overfullFight = withSeed(2, (rng) => resolveFight({ state: overfull, spot: spotFor(5135), pressure: {}, targetNpcId: 5135,
    rng, timestamp: TS, fightLimitMs: 60000, maxActions: 400 }));
assert.ok(overfullFight.hp <= overfullFight.maxHp && overfullFight.mp <= overfullFight.maxMp, 'solo start HP and MP are clamped to the maximum');
assert.deepStrictEqual(overfullFight.hp, soloOutcome(gladiator, 5135, 2).hp, 'an overfull bot fights like a bot at full HP');
// Every damage roll of a cold fight draws from the fight rng: Math.random does not change the outcome.
const fightWith = (randomSeed) => {
    const realRandom = Math.random;
    Math.random = seeded(randomSeed);
    try { return soloOutcome(tyrant, 5135, 7); } finally { Math.random = realRandom; }
};
assert.deepStrictEqual(fightWith(1), fightWith(2), 'physical damage spread comes from the fight rng, not Math.random');

// ---------- cold PvP: the shared attack and the cooldown from cast start ----------
const Pvp = invoke('GameServer/Bot/Population/ColdPvpResolver');
function duelist(id, skills) {
    const at = { locX: 50000, locY: 15000, locZ: -5000 };
    return { characterId: id, name: `Duelist${id}`, level: 40, classId: 0, phase: 'cold', loc: at,
        vitals: { hp: 1000, mp: 500 }, stats: { classId: 0, coldCombat: { version: 1, classId: 0, cp: 0, cpAt: TS,
            base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
            equipment: { weaponKind: 'Weapon.Sword', pAtk: 100, pAtkRnd: 0, mAtk: 100, atkSpd: 379, critical: 0, accur: 0,
                pDef: 200, mDef: 100, evasion: 0 },
            effects: [], skills } } };
}
const windStrike = { selfId: 1177, level: 5, spell: true, passive: false, power: 50, mp: 20, hitTime: 4000, reuse: 60000 };
const left = duelist(2001, [{ selfId: 1, level: 1, passive: true }]);
const right = duelist(2002, [windStrike]);
const duel = Pvp.resolve({ sides: [{ principal: left, members: [left] }, { principal: right, members: [right] }],
    roles: new Map(), timestamp: TS, rng: seeded(5), personaFor: () => ({ traits: { caution: 0 } }) });
assert.ok(duel.started, 'the duel starts');
const caster = duel.fighters.find((f) => f.id === 2002);
assert.strictEqual(caster.skills, 1, 'Wind Strike is cast once');
// side 1 opens at 0 ms: the 4000 ms cast starts at TS, its 60 s reuse with it (C4), not after the cast
assert.strictEqual(duel.updates.get(2002).stats.coldCombat.cooldowns[1177], TS + 60000, 'PvP reuse starts at cast start');

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
// A loaded spiritshot cuts a spell to 70% (Formulas.calcSkillHitTime, as hot); a physical skill keeps its time.
const shotDelay = (profile, skill) => Math.round(Resolver.combat.actionDelayMs(profile, skill, true) * 1000) / 1000;
// (4000 ms at cast speed 333 is 3999.99..., floored after the cut)
assert.strictEqual(shotDelay(speeds, { spell: true, hitTime: 4000 }), 2799, 'spell with a spiritshot: 70% of the cast');
assert.strictEqual(shotDelay(speeds, { spell: true, hitTime: 600 }), 500, 'spell with a spiritshot keeps the 500 ms floor');
assert.strictEqual(shotDelay(speeds, { spell: false, hitTime: 1200 }), 1200, 'physical skill: no spiritshot cut');

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
