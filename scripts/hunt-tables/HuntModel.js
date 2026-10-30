'use strict';

// The hunt model over the offline tables (data/Bots/hunt/*.json): a bot's
// strength as the sum of its class base card, henna and worn items, and the
// hunt numbers of one mob by formula. Not wired into the server yet; the
// tables' builder and its checks (build.js, verify.js) read it.
//
// The sum goes through the owner's numbers pass (ColdCombatProfile
// profileNumbers over equipmentFromTemplates), so only its inputs come from
// the tables: the base card's stats, the henna deltas and the items' raw rows.

const C = require('./common');

C.boot();
const DataCache = invoke('GameServer/DataCache');
const Index = require('../../src/GameServer/Item/ItemTemplateIndex');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const Formulas = invoke('GameServer/Formulas');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Mob = invoke('GameServer/Bot/Population/ColdMobAction');
const Enchant = invoke('GameServer/Items/C4EnchantRules');
const ItemSkills = invoke('GameServer/Items/C4EquipmentItemSkills');
const ArmorSets = invoke('GameServer/Items/C4ArmorSets');
const Hennas = invoke('GameServer/Henna/HennaRules');

const BASE_STATS = ['str', 'dex', 'con', 'int', 'wit', 'men'];
// Raw item stats a table row keeps (the fields equipmentFromTemplates reads).
const ITEM_STATS = ['pAtk', 'pAtkRnd', 'mAtk', 'atkSpd', 'crit', 'accur', 'reuseDelay', 'pDef', 'mDef', 'evasion', 'maxMp', 'shieldRate'];
// The numbers a strength carries (a profile's).
const NUMBERS = ['maxHp', 'maxMp', 'pAtk', 'mAtk', 'pDef', 'mDef', 'accur', 'evasion', 'critical', 'atkSpd', 'castSpd', 'con', 'men'];

// A cold bot state of a class key (C.kitKey: '7>9' a Rogue for the Hawkeye
// line) and level wearing items [{ selfId, slot, enchant }] with hennas
// (symbol ids) and skills (snapshots; default: the class tree at the level,
// as the spot table's reference bot learns it).
function kitState(key, level, items = [], { hennas = [], skills = null } = {}) {
    const { classId } = C.parseKitKey(key);
    const inventory = {};
    for (const item of items) {
        const key = `kit-${item.selfId}-${item.enchant || 0}`;
        const prior = inventory[key];
        const amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId: Number(item.selfId), amount, equipped: true, equippedCount: amount, enchant: Number(item.enchant) || 0,
            equippedSlots: [...(prior?.equippedSlots || []), Number(item.slot)], slot: Number(item.slot) };
    }
    // The key's line: a split-kit first class fights with its future's weapon.
    return { characterId: C.kitCharacterId(key), name: 'HuntTable', classId, level, activity: 'hunting', phase: 'cold', vitals: {},
        stats: { classId, hennas: [...hennas], coldCombat: { skillSource: 'database',
            skills: skills || Profile.skillSnapshotsFromRecords(Profile.skillRecordsFromTree(classId, level)) } },
        inventory };
}

// The owner's numbers of a state (no store: a what-if).
function profileOf(state) {
    return Profile.profileFor(state, 0, { store: false });
}

function numbersOf(profile) {
    const out = {};
    for (const key of NUMBERS) out[key] = profile[key];
    return out;
}

// One worn row as the profile prepares it, from a table item row
// { selfId, kind, slot, rank, stats }: the enchant's stat bonus and the
// item's own effect (weapon SA, item skill) by their owners.
function preparedRow(row, slot, enchant) {
    const adapter = { fetchSelfId: () => row.selfId, fetchId: () => row.selfId, fetchEnchantLevel: () => enchant,
        fetchRank: () => row.rank, fetchKind: () => row.kind, fetchSlot: () => slot,
        isWeapon: () => row.kind.startsWith('Weapon.'), isArmor: () => row.kind.startsWith('Armor.') };
    const stats = { ...row.stats };
    for (const stat of ['pAtk', 'mAtk', 'pDef', 'mDef']) stats[stat] = (Number(stats[stat]) || 0) + Enchant.statBonus(adapter, stat);
    return { selfId: row.selfId, template: { kind: row.kind }, stats, etc: { slot, rank: row.rank },
        equipmentEffect: ItemSkills.effectForItem(adapter) };
}

// A bot's strength: the class base card (classRow: table 3) plus the henna
// deltas (hennas: symbol ids, table 9) plus the worn items (items: [{ row,
// slot, enchant }], rows of table 5), with its skills (snapshots), through
// the owner's numbers pass. Returns the profile numbers (NUMBERS).
function strength(classRow, level, { hennas = [], items = [], skills = [] } = {}) {
    const base = { ...classRow.base, ...classRow.classStats };
    const delta = hennaDelta(hennas);
    for (const stat of BASE_STATS) base[stat] = (Number(base[stat]) || 1) + delta[stat];
    const worn = items.map(({ row, slot, enchant }) => preparedRow(row, slot, Number(enchant) || 0));
    const equipment = Profile.equipmentFromTemplates(worn, classRow.spellcaster, classRow.classStats);
    const ids = new Set(worn.map(row => Number(row.selfId)));
    const effects = [...ArmorSets.effectsForEquippedIds(ids),
        ...worn.map(row => row.equipmentEffect && { ...row.equipmentEffect, ...(row.equipmentEffect.stats ? { stats: { ...row.equipmentEffect.stats } } : {}) })
            .filter(Boolean)];
    const kitPart = { version: 1, capturedAt: 0, classId: classRow.classId, base, equipment, effects, skills, level,
        race: classRow.race, spellcaster: classRow.spellcaster };
    return numbersOf(Profile.profileNumbers(kitPart, effects, 0, { night: false }));
}

// The henna deltas of symbol ids by the server's rule (HennaRules.totals:
// each stat's sum, at most +5), lower-case keys.
function hennaDelta(symbolIds) {
    const totals = Hennas.totals(symbolIds);
    const out = {};
    for (const stat of BASE_STATS) out[stat] = Number(totals[stat.toUpperCase()]) || 0;
    return out;
}

// Seated regeneration per 3-second tick of a strength (ColdRest; a whole
// profile also brings its passives and kit).
function regenOf(classId, level, numbers) {
    return ColdRest.coldRestRegenPerTick({ classId, level, stats: { classId } },
        { stats: { con: numbers.con, men: numbers.men }, profile: numbers.skills ? numbers : undefined });
}

module.exports = { BASE_STATS, ITEM_STATS, NUMBERS, kitState, profileOf, numbersOf, strength, hennaDelta, regenOf,
    Formulas, Matchup, DataCache, Index, Profile, ColdRest };

// ------------------------------------------------------------ hunt formula

const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const MobExperience = invoke('GameServer/Progression/MobExperience');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');

// A rotation row of table 4 as an object (fields: the table's); key: C.kitKey.
function rotationOf(rotationTable, key, level) {
    const rows = rotationTable.rows[key];
    if (!rows) return null;
    const bands = Object.keys(rows).map(Number);
    const want = Math.floor(level / rotationTable.bandLevels);
    const band = bands.reduce((best, b) => Math.abs(b - want) < Math.abs(best - want) ? b : best, bands[0]);
    const rot = Object.fromEntries(rotationTable.fields.map((field, index) => [field, rows[band][index]]));
    rot.openingSeconds = rotationTable.openingSeconds;
    return rot;
}

// A value of the opening curve at t seconds (linear between points; before
// the first the first, after the last the last for a rate, the long-run MP
// rate added for MP).
function openingAt(rot, list, t, rate = null) {
    const times = rot.openingSeconds || [];
    if (!times.length || !list) return null;
    if (t <= times[0]) return rate === null ? list[0] : list[0] * t / times[0];
    for (let i = 1; i < times.length; i++) {
        if (t <= times[i]) {
            const w = (t - times[i - 1]) / (times[i] - times[i - 1]);
            return list[i - 1] + w * (list[i] - list[i - 1]);
        }
    }
    return rate === null ? list.at(-1) : list.at(-1) + rate * (t - times.at(-1));
}

// The rotation's damage rate times defence (dps x def) for a strength:
// physical and magic parts, with MP (the rotation) and without (dry).
function damageTerms(rot, numbers, mobEvasion) {
    const speed = numbers.atkSpd * (1 + numbers.critical / 1000) * Formulas.hitChance(numbers.accur, mobEvasion) / 0.98;
    const phys = (rot.A * numbers.pAtk + rot.B) * speed;
    const magic = rot.M * Math.sqrt(Math.max(1, numbers.mAtk)) * numbers.castSpd / 333;
    // A rotation that never ran dry in its measure keeps its MP-phase rate.
    const dry = rot.dryUnit > 0 ? rot.dryUnit * numbers.pAtk * speed : rot.mpPhaseSec >= 180 ? phys : 0;
    return { phys, magic, dry };
}

function normalCdf(x) {
    // Abramowitz-Stegun 7.1.26 on erf.
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
        * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// The wait after a rest ends (BackgroundResolver.resolveRest: next step in 30 s).
const REST_TAIL_S = 30;

// The cold step's mean combat budget and length (resolveSolo: budget =
// elapsed, T106; elapsed = huntCycleDelayMs of a uniform roll).
let held = null;
function stepTimes() {
    if (held) return held;
    const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    let budget = 0, cycle = 0;
    for (let i = 0; i < 1000; i++) {
        const delay = Resolver.huntCycleDelayMs((i + 0.5) / 1000);
        budget += delay / 1000;
        cycle += delay / 1000;
    }
    held = { budget: budget / 1000, cycle: cycle / 1000 };
    return held;
}

// One mob's hunt numbers for a bot by formula (no fight run):
// bot { key (C.kitKey, default classId), classId, level, profile (the owner's profile of the kit), rot
// (rotationOf), shots, potions (default true) }, mob { combat (table 1 combat fields as an object),
// exp, sp, reward (DataCache reward shape), pull (the spot entry's mean) },
// correction (table 8 row { kph, deaths } or null).
// Returns null when the bot's solo gate refuses the mob (BotTargetMatchup
// soloCanHunt on its cold profiles), else per kill fight, rest, taken,
// death chance and per hour kills, deaths, exp, SP and drops by item.
// A kit's state and matchup profiles as the cold fight builds them (resolveFight).
function matchupOf(bot) {
    const state = { characterId: C.kitCharacterId(bot.key ?? bot.classId), classId: bot.classId, level: bot.level,
        stats: { classId: bot.classId }, vitals: { mp: bot.profile.maxMp } };
    return { state, profiles: Matchup.coldProfiles({ ...bot.profile, role: invoke('GameServer/Bot/AI/BotRoles').combatRoleFor(state) }, state, 0) };
}

function mobHour(bot, mob, correction = null) {
    const { profile, rot } = bot;
    const target = mob.combat;
    const { state, profiles } = matchupOf(bot);
    const pull = Math.max(1, Number(mob.pull) || 1);
    // A pull the rotation's area skills wear down together hits as more mobs.
    const view = Pull.pullView(target, pull, Number(rot.areaShare) || 0);
    // The gate judges the pull the fight meets (BotTargetMatchup.npcVerdict).
    if (!Matchup.soloCanHunt(profiles, Pull.pullView(target, Math.round(pull))).eligible) return null;
    const terms = damageTerms(rot, profile, target.evasion);
    const shot = bot.shots ? rot.shotMul : 1;
    // Area skills strike every mob of the pull (resolveFight): the measured
    // area share of the rotation's damage counts pull times.
    const area = 1 + (Number(rot.areaShare) || 0) * (pull - 1);
    const wet = (terms.phys / Math.max(1, view.pDef) + terms.magic / Math.max(1, view.mDef)) * shot * area;
    const dry = terms.dry / Math.max(1, view.pDef) * shot;
    const manaRest = RestPolicy.restsForMana(state);
    const regen = regenOf(bot.classId, bot.level, profile);
    // The mob's actions on the bot as the cold fight rolls them (ColdMobAction.actionMix:
    // weapon hits, criticals, skills), in expectation.
    const mix = Mob.actionMix(view, { profile });
    // The cold step (resolveSolo): a fight runs at most the step's combat
    // budget, then waits for the next step, which first adds the standing
    // regeneration of the whole elapsed step (applyStandingRegen).
    const { budget, cycle } = stepTimes();
    const standing = ColdRest.coldRestRegenPerTick(state, { profile, standing: true }).hp / 3;
    let share = 1, fight = 0, rest = 0, taken = 0, mpSpent = 0, wall = 0, worst = 0;
    // Share of the fight on the rotation (MP) when the bot does not rest for
    // mana: what its rest refills of the MP the fight spends (two passes).
    // A bot that rests for mana opens each fight at full MP (its rest also
    // outlasts the cooldowns): its first seconds deal and spend by the opening
    // curve (fight length by three passes). Others fight on at the long-run rate.
    const opens = manaRest;
    // A rotation that deals nothing with MP (all of it on songs) fights dry.
    if (!(wet > 0)) share = 0;
    for (let pass = 0; pass < 2; pass++) {
        const dps = share * wet + (1 - share) * dry;
        if (!(dps > 0)) return null;
        fight = view.maxHp / dps;
        for (let step = 0; step < 3 && opens; step++) {
            const burst = openingAt(rot, rot.openDamage, fight);
            if (burst > 0) fight = view.maxHp / (dps * burst);
        }
        taken = mix.perSecond * fight;
        const steps = Math.max(1, Math.ceil(fight / budget));
        wall = fight + (steps - 1) * (cycle - budget);
        // The most the fight's HP falls: its first step's damage, or all of it
        // less the regeneration between steps when the steps outpace it.
        worst = Math.max(taken * Math.min(1, budget / fight), taken - standing * cycle * (steps - 1));
        const opened = opens ? openingAt(rot, rot.openMp, fight, rot.mpPerSec) : null;
        mpSpent = opened !== null ? Math.min(profile.maxMp, opened) : rot.mpPerSec * fight * share;
        rest = ColdRest.restSeconds(state, Math.max(0, taken - standing * wall), mpSpent, { regen, requireMana: manaRest });
        if (manaRest || mpSpent <= 0 || !(wet > 0)) break;
        share = Math.min(1, (regen.mp / 3) * (rest + fight) / (rot.mpPerSec * fight));
    }
    // Death: the fight's damage over the bot's HP, its spread from the
    // actions' rolls (hit, critical, skill, damage spread).
    const attempts = mix.actionsPerSecond * fight;
    const sigma = Math.sqrt(Math.max(1e-9, attempts * (mix.squarePerAction - Math.pow(mix.perAction, 2))));
    // One healing potion a fight (BackgroundResolver.startColdPotion) when the
    // bot carries them (bot.potions; its heal over time counted whole).
    const potion = bot.potions === false ? 0 : Number(Potions.purchasePotionFor({ level: bot.level })?.heal) || 0;
    const deathFrom = startHp => worst > 0 ? 1 - normalCdf((startHp + potion - worst) / (sigma * worst / taken)) : 0;
    // A fight that kills the bot kills no mob (the cold death ends the fight;
    // the bot stands up at once, as the spot table counts it).
    // A step fights at most its budget, then waits out its cycle: the wait
    // covers a rest, else it is idle (a kill takes fight x cycle / budget of
    // wall time; the waits between a long fight's steps are in wall already).
    const idle = Math.max(0, fight * cycle / budget - wall);
    // A rest is taken once the HP (or a caster's MP) falls below the solo
    // threshold (RestPolicy.THRESHOLDS), to full, and its last step waits
    // REST_TAIL_S more (resolveRest: the step after the rest ends).
    const limits = RestPolicy.THRESHOLDS.solo;
    const hpLoss = Math.max(0, taken - standing * wall);
    let restEvery = hpLoss > 0 ? Math.floor((1 - limits.hp) * profile.maxHp / hpLoss) + 1 : Infinity;
    if (manaRest && mpSpent > 0) restEvery = Math.min(restEvery, Math.floor((1 - limits.mp) * profile.maxMp / mpSpent) + 1);
    const tail = Number.isFinite(restEvery) ? REST_TAIL_S / restEvery : 0;
    // A solo bot rests only below the threshold: the fights between two rests
    // start lower and lower (their mean death chance).
    const between = Math.min(Number.isFinite(restEvery) ? restEvery : 1, 50);
    let deathChance = 0;
    for (let j = 0; j < between; j++) deathChance += deathFrom(profile.maxHp - j * hpLoss) / between;
    let cycles = 3600 / Math.max(1, wall + Math.max(rest, idle) + tail);
    if (correction) {
        cycles *= correction.kph;
        deathChance = Math.min(1, deathChance * correction.deaths);
    }
    const kills = cycles * pull * (1 - deathChance);
    const gap = bot.level - target.level;
    const drops = {};
    if (mob.reward) {
        const context = { npcLevel: target.level, killerLevel: bot.level };
        const ids = new Set((mob.reward.rewards || []).flatMap(group => group.items.map(item => item.selfId)));
        for (const id of ids) {
            const amount = Planner.itemDropYield(mob.reward, id, 'drop', context).expectedYield * kills;
            if (amount > 0) drops[id] = amount;
        }
    }
    return { fight, wall, rest, taken, deathChance, share, fightsPerHour: cycles, kph: kills, deathsPerHour: cycles * deathChance,
        exp: kills * mob.exp, expAfterGap: kills * mob.exp * MobExperience.gapFactor(gap), sp: kills * mob.sp, drops };
}

module.exports.rotationOf = rotationOf;
module.exports.damageTerms = damageTerms;
module.exports.mobHour = mobHour;
module.exports.matchupOf = matchupOf;
