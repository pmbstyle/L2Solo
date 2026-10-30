'use strict';

// Table 4, rotation: per class and 2-level band, what the class's real cold
// fight (BackgroundResolver.resolveFight: its skill choice, charges, summons,
// cast and attack times) deals against a dummy target that never hits back,
// in the author's kit for the level (HuntCycle.referenceState).
//
// Damage per second at defence def splits into a physical and a magic part:
//   dps = phys(pAtk, atkSpd, critical) / pDef + magic(mAtk, castSpd) / mDef
//   phys  = (A x pAtk + B) x atkSpd x (1 + critical / 1000) x hit / 0.98
//   magic = M x sqrt(mAtk) x castSpd / 333
// A is the share of damage that grows with P.Atk (normal attacks, skill
// P.Atk), B the part that does not (skill power, a summon). Four runs per
// row: the kit at defences (1000, 1000), the kit at (2000, 1000) (splits the
// two parts), the kit without its weapon (a second P.Atk, solves A and B),
// the kit with shots (the shot multiplier), a pull of two (the area share).
// The opening: what a fight from full MP deals and spends in its first 3, 6,
// 12, 24, 48 s (openDamage over the long run's rate, openMp cumulative), the
// burst every hunt fight after a rest starts with.
// Each run fights in 12-second
// slices until the MP is gone (the MP phase) and, in the first run, on
// without MP (the dry phase: what the bot deals once its mana is out).

const C = require('./common');
const M = require('./HuntModel');

const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const ClassProgression = invoke('GameServer/ClassProgression');
const PveEncounter = require('../../src/GameServer/Bot/Population/ColdPveEncounter');
const Formulas = invoke('GameServer/Formulas');

// The real solo step's shortest combat budget (resolveSolo: 12 s): a shorter
// slice ends inside a summon's cast and loses the summon.
const SLICE_MS = 12000;
const MP_PHASE_MAX_MS = 180000;
const DRY_MS = 60000;
const DEF = 1000;
const START = 1_750_000_000_000;
// Levels a class's rotation is measured at, by profession stage (a bot may
// keep a profession past the next one's level).
const STAGE_LEVELS = [[1, 25], [20, 51], [40, C.MAX_LEVEL]];

// ARCH-NOTE (as in generate-spot-table.js): cold combat spends shots only when
// ShotStock.usePolicy, read from the spot table, says they pay; the shots run
// measures them loaded.
ShotStock.usePolicy = () => ({ usePerHour: 1 });

const SPOT = { id: 'hunt-tables-dummy', npcEntries: [], avgLevel: 1 };

// The dummy shows the class policy (ColdClassPolicy, which reads the
// target's max HP) the typical mob's HP of its level; its own HP never ends.
function dummy(level, pDef, mDef, maxHp, pull = 1) {
    return { selfId: 0, level, maxHp, pull, pAtk: 1, pAtkRnd: 0, pDef, mDef, basePDef: pDef, baseMDef: mDef, accur: 1, evasion: 0,
        critical: 0, atkSpd: 1, castSpd: 333, race: '', undead: false, vulnerabilities: {}, rewardExp: 0, rewardSp: 0 };
}

// The bot of a class key (C.kitKey: '7>9' a Rogue with the Hawkeye's bow)
// and level in the author's kit; weaponless: the kit without its weapon;
// shots: its weapon's shots loaded (never running out).
function rotationBot(classKey, level, { weaponless = false, shots = false } = {}) {
    const { classId, future } = C.parseKitKey(classKey);
    const state = HuntCycle.referenceState(classId, level, { line: future });
    if (weaponless) {
        for (const [key, item] of Object.entries(state.inventory)) {
            if ([7, 14].includes(Number(item.slot))) delete state.inventory[key];
        }
    }
    if (shots) {
        const plan = ShotStock.planForState(state);
        if (plan.selfId && plan.perAction > 0) state.inventory[String(plan.selfId)] = { selfId: Number(plan.selfId), amount: 1e9 };
    }
    const profile = M.profileOf(state);
    state.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
    state.loc = { locX: 0, locY: 0, locZ: 0 };
    return { state, profile };
}

// The fight in slices against the dummy. Returns the MP phase { ms, damage,
// mp } and the dry phase { ms, damage } (dry only when asked).
function fight(classKey, level, pDef, mDef, options = {}, dry = false) {
    const { state, profile } = rotationBot(classKey, level, options);
    const mob = dummy(level, pDef, mDef, typicalHp(level), options.pull || 1);
    const rng = C.mulberry(C.hash(`${classKey}|${level}|${pDef}|${mDef}|${JSON.stringify(options)}`));
    const key = PveEncounter.key([state], SPOT, 0);
    let t = START, botReadyAt = 0, hp = 1e12;
    const phase = { ms: 0, damage: 0, mp: 0 }, dryPhase = { ms: 0, damage: 0 };
    const empty = () => state.vitals.mp < 0.05 * profile.maxMp;
    let elapsed = 0;
    while (elapsed < MP_PHASE_MAX_MS + (dry ? DRY_MS : 0)) {
        const inDry = empty();
        if (inDry && (!dry || dryPhase.ms >= DRY_MS)) break;
        if (!inDry && elapsed >= MP_PHASE_MAX_MS) break;
        state.stats.pveEncounter = { version: 1, key, mob, hp, at: t, slices: 0, botReadyAt, mobReadyAt: 1e15 };
        const mpBefore = state.vitals.mp;
        const result = Resolver.resolveFight({ state, spot: SPOT, rng, timestamp: t, fightLimitMs: SLICE_MS, maxActions: 10000 });
        const ms = Number(result.debug?.durationMs) || SLICE_MS;
        const dealt = hp - Number(result.encounter?.hp ?? hp);
        hp = Number(result.encounter?.hp ?? hp);
        botReadyAt = Number(result.encounter?.botReadyAt) || 0;
        state.vitals = { ...state.vitals, hp: result.hp, mp: result.mp };
        state.inventory = result.inventory || state.inventory;
        state.stats.coldCombat = { ...state.stats.coldCombat, cooldowns: result.cooldowns || {}, charges: result.charges || 0,
            chargeExpiresAt: result.chargeExpiresAt || null, effects: result.effects || [], summon: result.summon || null };
        const target = inDry ? dryPhase : phase;
        target.ms += ms;
        target.damage += dealt;
        if (!inDry) phase.mp += Math.max(0, mpBefore - result.mp);
        t += ms;
        elapsed += ms;
    }
    return { profile, phase, dryPhase };
}

// The median max HP of the spot catalogue's mobs of a level (table 1; the
// nearest level that has mobs).
let hpByLevel = null;
function typicalHp(level) {
    if (!hpByLevel) {
        const mobs = C.readTable('mobs');
        const lists = {};
        for (const mob of mobs.mobs) { const combat = mobs.combats[mob[2]]; (lists[combat[0]] ||= []).push(combat[1]); }
        hpByLevel = Object.fromEntries(Object.entries(lists).map(([l, list]) => [l, list.sort((a, b) => a - b)[Math.floor(list.length / 2)]]));
    }
    for (let d = 0; d < 90; d++) for (const l of [level - d, level + d]) if (hpByLevel[l]) return hpByLevel[l];
    return 1000;
}

// A fight from full MP and fresh cooldowns, as every hunt fight after a
// rest starts: the damage (dps x def at defences 1000) and MP of its first
// t seconds, one uncut fight per t.
const OPENING_SECONDS = [3, 6, 12, 24, 48];
function opening(classKey, level) {
    return OPENING_SECONDS.map(seconds => {
        const { state, profile } = rotationBot(classKey, level);
        const mob = dummy(level, DEF, DEF, typicalHp(level));
        state.stats.pveEncounter = { version: 1, key: PveEncounter.key([state], SPOT, 0), mob, hp: 1e12, at: START, slices: 0,
            botReadyAt: 0, mobReadyAt: 1e15 };
        const result = Resolver.resolveFight({ state, spot: SPOT, rng: C.mulberry(C.hash(`${classKey}|${level}|open|${seconds}`)),
            timestamp: START, fightLimitMs: seconds * 1000, maxActions: 10000 });
        return { damage: (1e12 - Number(result.encounter?.hp ?? 1e12)) * DEF / seconds, mp: profile.maxMp - result.mp };
    });
}

function perSecond(part) {
    return part.ms > 0 ? part.damage / (part.ms / 1000) : 0;
}

function hitShare(profile) {
    return Formulas.hitChance(profile.accur, 0) / 0.98;
}

// The physical part of a damage rate over its speed, critical and hit terms.
function physUnit(physical, profile) {
    return physical / (profile.atkSpd * (1 + profile.critical / 1000) * hitShare(profile));
}

function measure(classKey, level) {
    const kit = fight(classKey, level, DEF, DEF, {}, true);
    const harder = fight(classKey, level, 2 * DEF, DEF);
    const bare = fight(classKey, level, DEF, DEF, { weaponless: true });
    const shot = fight(classKey, level, DEF, DEF, { shots: true });
    // A pull of two: an area skill strikes both (resolveFight), so the
    // damage over one mob's is 1 + the area share.
    const pair = fight(classKey, level, DEF, DEF, { pull: 2 });
    const d1 = perSecond(kit.phase) * DEF, d2 = perSecond(harder.phase) * DEF;
    // Physical part at defence 1000 (halves at 2000), magic the rest.
    const phys1 = Math.max(0, Math.min(d1, 2 * (d1 - d2)));
    const magic1 = Math.max(0, d1 - phys1);
    const mUnit = magic1 / (Math.sqrt(kit.profile.mAtk) * kit.profile.castSpd / 333);
    const bareMagic = mUnit * Math.sqrt(bare.profile.mAtk) * bare.profile.castSpd / 333;
    const phys3 = Math.max(0, perSecond(bare.phase) * DEF - bareMagic);
    const u1 = physUnit(phys1, kit.profile), u3 = physUnit(phys3, bare.profile);
    const p1 = kit.profile.pAtk, p3 = bare.profile.pAtk;
    let A = p1 !== p3 ? (u1 - u3) / (p1 - p3) : u1 / p1;
    // A negative slope is noise (no P.Atk-driven damage): all of it fixed.
    if (!(A >= 0)) A = 0;
    const B = Math.max(0, u1 - A * p1);
    const dry = perSecond(kit.dryPhase) * DEF;
    const shotMul = d1 > 0 ? perSecond(shot.phase) * DEF / d1 : 1;
    const mpPerSec = kit.phase.ms > 0 ? kit.phase.mp / (kit.phase.ms / 1000) : 0;
    const open = opening(classKey, level);
    return { level, refPAtk: p1, refMAtk: kit.profile.mAtk, refAtkSpd: kit.profile.atkSpd, refCastSpd: kit.profile.castSpd,
        A, B, M: mUnit, magicShare: d1 > 0 ? magic1 / d1 : 0, mpPerSec, mpPhaseSec: kit.phase.ms / 1000,
        dryUnit: physUnit(dry, kit.profile) / Math.max(1, p1), shotMul,
        areaShare: d1 > 0 ? Math.max(0, perSecond(pair.phase) * DEF / d1 - 1) : 0, d1,
        openDamage: open.map(point => d1 > 0 ? C.round(point.damage / d1) : 1), openMp: open.map(point => C.round(point.mp)) };
}

const FIELDS = ['level', 'refPAtk', 'refMAtk', 'refAtkSpd', 'refCastSpd', 'A', 'B', 'M', 'magicShare', 'mpPerSec', 'mpPhaseSec',
    'dryUnit', 'shotMul', 'areaShare', 'd1', 'openDamage', 'openMp'];

function bandsFor(classId) {
    const stage = Math.max(0, Math.min(2, ClassProgression.lineage(classId).length - 1));
    const [from, to] = STAGE_LEVELS[stage];
    const bands = [];
    for (let band = Math.floor(from / 2); band <= Math.floor(to / 2); band++) bands.push(band);
    return bands;
}

function build(classTable, gearTable, options = {}) {
    const rows = {};
    let runs = 0;
    const classes = classTable.classes.map(row => row.key ?? String(row.classId));
    const picked = options.sample > 0 ? classes.filter((_, index) => index % Math.ceil(classes.length / options.sample) === 0) : classes;
    for (const classKey of picked) {
        rows[classKey] = {};
        for (const band of bandsFor(C.parseKitKey(classKey).classId)) {
            const level = Math.max(1, Math.min(C.MAX_LEVEL, 2 * band + 1));
            const measured = measure(classKey, level);
            rows[classKey][band] = FIELDS.map(field => Array.isArray(measured[field]) ? measured[field] : C.round(measured[field]));
            runs += 5;
        }
        process.stderr.write(`  rotation class ${classKey}: ${Object.keys(rows[classKey]).length} bands\n`);
    }
    return { body: { bandLevels: 2, def: DEF, openingSeconds: OPENING_SECONDS, fields: FIELDS, rows },
        counts: { classes: picked.length, rows: Object.values(rows).reduce((sum, row) => sum + Object.keys(row).length, 0), runs },
        inputs: { sliceMs: SLICE_MS, mpPhaseMaxMs: MP_PHASE_MAX_MS, dryMs: DRY_MS, def: DEF, stageLevels: STAGE_LEVELS } };
}

module.exports = { build, measure, FIELDS, physUnit, hitShare };
