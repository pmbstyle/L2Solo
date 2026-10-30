'use strict';

// Table 8, corrections: the formula (HuntModel.mobHour) against the real
// cold hunt (generate-spot-table.js hunt: BackgroundResolver.resolveSolo
// hour by hour, the spot table's own measure) on a sample of classes x gear
// x mobs x level gaps, one mob species per synthetic spot. Per rotation kind
// (phys / magic) x danger (solo: one mob per pull / crowd: more) the
// multiplier real / formula of kills per hour and of deaths per kill.
// The sample is split by a hash: the even half fits the multipliers, the odd
// half measures the corrected formula's error (verify.js prints it).

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./common');
const M = require('./HuntModel');
const S = require('./static-tables');

const { GRADES, gradeForLevel } = invoke('GameServer/Bot/AI/GearGradeRule');
const ClassProgression = invoke('GameServer/ClassProgression');

const HOURS = 0.5;
// Classes by kind: melee, dagger, archer, nuker, summoner, healer, buffer,
// spoiler (class keys, C.kitKey: '7>9' would be a Rogue with the Hawkeye's bow).
const SAMPLE_CLASSES = [1, 2, 3, 4, 8, 9, 11, 12, 14, 15, 16, 17, 27, 41, 50, 51, 55];
const GAPS = [-2, 2, 5, 8];
const FIELDS = ['classId', 'level', 'gear', 'mob', 'pull', 'rotKind', 'danger', 'half',
    'realKph', 'realDeathsPerHour', 'realFight', 'realRest', 'formulaKph', 'formulaDeathsPerHour', 'formulaFight', 'formulaRest'];

function levelsFor(classId) {
    const stage = ClassProgression.lineage(classId).length - 1;
    return stage <= 0 ? [12, 18] : stage === 1 ? [25, 35] : [45, 55, 65, 74];
}

// Gear options: the author's kit, and two live-like kits from the class's
// tiers (table 5): this grade's weakest weapon with its body armour, and the
// grade below's best weapon with no armour.
function gearOptions(gearClass, level) {
    const grade = gradeForLevel(level);
    const below = GRADES[Math.max(0, GRADES.indexOf(grade) - 1)];
    const tier = (list, name) => list.find(row => row[0] === name)?.[1] || null;
    const options = [['kit', null]];
    const weakWeapon = tier(gearClass.weaponTiers, `${grade}-low`) || tier(gearClass.weaponTiers, `${grade}-top`);
    const body = tier(gearClass.armourTiers, `${grade}-body`) || tier(gearClass.armourTiers, `${grade}-full`);
    if (weakWeapon && body) options.push([`${grade}-low+${grade}-body`, [...weakWeapon, ...body]]);
    const old = tier(gearClass.weaponTiers, `${below}-top`);
    if (old && below !== grade) options.push([`${below}-top+none`, [...old]]);
    return options;
}

function itemRows(gearTable) {
    return new Map(gearTable.items.map(row => [row[0], Object.fromEntries(gearTable.itemFields.map((field, i) => [field, row[i]]))]));
}

function wearList(ids, items) {
    return ids.flatMap(id => S.wear(items.get(id)));
}

// The mobs of a level window, one solo and one crowd species per level gap,
// from the spot catalogue (table 2, the pull of their spawn group).
function sampleMobs(tables, level, seed, admits = () => true) {
    const combatOf = new Map(tables.mobs.mobs.map(mob => [mob[0], mob]));
    const picks = [];
    for (const gap of GAPS) {
        const want = level - gap;
        for (const danger of ['solo', 'crowd']) {
            const candidates = [];
            for (const spot of tables.spots.spots) for (const [npcId, , pull] of spot[5]) {
                const mob = combatOf.get(npcId);
                if (!mob || tables.mobs.combats[mob[2]][0] !== want) continue;
                if ((danger === 'crowd') !== (pull > 1.05)) continue;
                candidates.push({ spot, npcId, pull });
            }
            if (!candidates.length) continue;
            candidates.sort((a, b) => C.hash(`${seed}|${a.spot[0]}|${a.npcId}`) - C.hash(`${seed}|${b.spot[0]}|${b.npcId}`));
            // The first species the kit's solo gate admits (a refused mob is
            // refused alike by the formula and the real fight: same gate).
            const admitted = candidates.find(candidate => admits(candidate)) || candidates[0];
            picks.push({ ...admitted, gap, danger });
        }
    }
    return picks;
}

function syntheticSpot(pick, index) {
    const [id, , , , , , , adenaMin, adenaMax, center] = pick.spot;
    const level = Number(pick.level);
    return { id: `ht-${index}-${id}`, name: `hunt-tables ${index}`, center: { locX: center[0], locY: center[1], locZ: center[2] },
        minLevel: level, maxLevel: level, avgLevel: level, density: 300, npcNames: [], npcSelfIds: [pick.npcId],
        npcEntries: [{ selfId: pick.npcId, count: 20, pull: pick.pull }], arrivalPoints: [], levelCounts: {}, dominantLevels: [],
        area: null, tags: [], tagsAuthoritative: false, capacity: null, localStarterRegions: [], localUntilLevel: null, route: null,
        rewards: { adenaMin, adenaMax }, mob: { hp: 1, damage: 1, hitDelayMs: 1600 }, risk: 0 };
}

function mobInput(tables, npcId, pull) {
    const mob = tables.mobs.mobs.find(row => row[0] === npcId);
    const combat = Object.fromEntries(tables.mobs.combatFields.map((field, i) => [field, tables.mobs.combats[mob[2]][i]]));
    combat.basePDef = combat.pDef; combat.baseMDef = combat.mDef;
    combat.vulnerabilities = combat.vulnerabilities || {};
    combat.undead = combat.undead === 1;
    // The species, for its skills in the fight (ColdMobAction.actionMix).
    combat.selfId = npcId;
    return { combat, exp: mob[3], sp: mob[4], reward: mob[6] >= 0 ? S.rewardsOf(tables.mobs.rewards[mob[6]]) : null, pull, danger: mob[5] };
}

// The profile of a sample kit of a class key: the author's (ids null) or a tier list.
function kitProfile(key, level, ids, items) {
    const { classId, future } = C.parseKitKey(key);
    const state = M.kitState(key, level, ids ? wearList(ids, items) : []);
    if (!ids) state.inventory = invoke('GameServer/Bot/AI/HuntCycle').referenceState(classId, level, { line: future }).inventory;
    return M.profileOf(state);
}

function rotKind(rot) {
    return rot.magicShare > 0.5 ? 'magic' : 'phys';
}

function build(tables, options = {}) {
    const generator = require('../generate-spot-table');
    tables.spots = C.readTable('spots');
    const items = itemRows(tables.gear);
    const tasks = [];
    // A split-kit first class is sampled once per future line (C.kitFutures).
    const keys = SAMPLE_CLASSES.flatMap(classId => C.kitFutures(classId).map(future => C.kitKey(classId, future)));
    for (const key of keys) {
        const { classId } = C.parseKitKey(key);
        const gearClass = C.rowOfKey(tables.gear.classes, key);
        for (const level of levelsFor(classId)) {
            const rot = M.rotationOf(tables.rotation, key, level);
            for (const [gearName, ids] of gearOptions(gearClass, level)) {
                const profile = kitProfile(key, level, ids, items);
                const admits = candidate => !!rot && M.mobHour({ key, classId, level, profile, rot, shots: true },
                    mobInput(tables, candidate.npcId, candidate.pull)) !== null;
                for (const pick of sampleMobs(tables, level, `${key}|${level}|${gearName}`, admits)) {
                    tasks.push({ key, classId, level, gearName, ids, pick: { ...pick, level: level - pick.gap } });
                }
            }
        }
    }
    const limit = options.sample > 0 ? options.sample : tasks.length;
    const chosen = tasks.sort((a, b) => C.hash(JSON.stringify([a.classId, a.level, a.gearName, a.pick.npcId]))
        - C.hash(JSON.stringify([b.classId, b.level, b.gearName, b.pick.npcId]))).slice(0, limit);
    const spots = chosen.map((task, index) => syntheticSpot(task.pick, index));
    const file = path.join(os.tmpdir(), `hunt-tables-spots-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ spots, profiles: spots }));
    const rows = [];
    try {
        generator.loadSimulation(file);
        chosen.forEach((task, index) => {
            const spot = spots[index];
            const kit = task.ids ? bot => { bot.inventory = M.kitState(task.key, task.level, wearList(task.ids, items)).inventory; } : null;
            // The hunt's line: a split-kit key's future second class (its reference bot), else any.
            const line = C.parseKitKey(task.key).future;
            const sum = generator.hunt(spot, line === null ? 'dps' : String(line), task.level, 1, HOURS, undefined, kit, task.classId);
            const profile = kitProfile(task.key, task.level, task.ids, items);
            const rot = M.rotationOf(tables.rotation, task.key, task.level);
            const mob = mobInput(tables, task.pick.npcId, task.pick.pull);
            const formula = rot ? M.mobHour({ key: task.key, classId: task.classId, level: task.level, profile, rot, shots: true }, mob) : null;
            const kills = sum.kills;
            rows.push([line === null ? task.classId : task.key, task.level, task.gearName, task.pick.npcId, task.pick.pull, rot ? rotKind(rot) : 'none',
                task.pick.danger, C.hash(`${index}|${task.pick.npcId}`) % 2,
                C.round(kills / HOURS), C.round(sum.deaths / HOURS), C.round(kills > 0 ? sum.fightMs / 1000 / kills : 0),
                C.round(kills > 0 ? sum.restMs / 1000 / kills : 0),
                C.round(formula?.kph || 0), C.round(formula?.deathsPerHour || 0), C.round(formula?.fight || 0), C.round(formula?.rest || 0)]);
            if ((index + 1) % 25 === 0) process.stderr.write(`  corrections ${index + 1}/${chosen.length}\n`);
        });
    } finally {
        fs.rmSync(file, { force: true });
    }
    const corrections = fit(rows);
    return { body: { hours: HOURS, sampleFields: FIELDS, sample: rows, fields: ['kph', 'deaths', 'n'], corrections },
        counts: { tasks: tasks.length, sampled: rows.length, simulatedHours: rows.length * HOURS },
        inputs: { hours: HOURS, classes: SAMPLE_CLASSES, gaps: GAPS } };
}

// Per rotation kind x danger on the fit half (half 0), rows both sides hunt:
// kills per hour by the median of real / formula (a few runaway rows must
// not move the group), deaths per hour by the ratio of sums (0 when the
// real fight has none; 1 when only the formula has none: no ratio to read).
function fit(rows) {
    const at = field => FIELDS.indexOf(field);
    const groups = {};
    for (const row of rows) {
        if (row[at('half')] !== 0 || !(row[at('formulaKph')] > 0) || !(row[at('realKph')] > 0)) continue;
        const key = `${row[at('rotKind')]}|${row[at('danger')]}`;
        const group = groups[key] || (groups[key] = { ratios: [], realDeaths: 0, formulaDeaths: 0 });
        group.ratios.push(row[at('realKph')] / row[at('formulaKph')]);
        group.realDeaths += row[at('realDeathsPerHour')];
        group.formulaDeaths += row[at('formulaDeathsPerHour')];
    }
    const out = {};
    for (const [key, group] of Object.entries(groups)) {
        const sorted = group.ratios.sort((a, b) => a - b);
        out[key] = [C.round(sorted[Math.floor(sorted.length / 2)]),
            group.formulaDeaths > 0 ? C.round(group.realDeaths / group.formulaDeaths) : 1, sorted.length];
    }
    return out;
}

module.exports = { build, fit, FIELDS, mobInput, rotKind, gearOptions, itemRows, wearList };
