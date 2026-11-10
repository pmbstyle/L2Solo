'use strict';

const Types = require('../AI/BotPersonaTypes');
const Config = require('./PopulationConfig');
const FailureLog = require('../../../FailureLog');

// The class mix of new bots ([BotPopulation] classMix): a weight per C4 starting
// class, by name; the professions then split evenly (BotClassProgression). Our
// choice, after the popularity of C4 classes among players: the default gives
// ~75 % damage dealers, ~7 % healers (half of the Human Mystics through Cleric to
// Bishop, half of the Elven and Dark Mystics through the Oracles), ~6 % buffers
// (the other Clerics to Prophet, every Orc Mystic to Shaman) and ~12 % dwarves.
const CLASS_NAMES = Object.freeze({ humanFighter: 0, humanMystic: 10, elfFighter: 18, elfMystic: 25,
    darkFighter: 31, darkMystic: 38, orcFighter: 44, orcMystic: 49, dwarf: 53 });
// The starter region (race) of each starting class: human, elf, dark elf, orc, dwarf.
const RACE_OF = Object.freeze({ 0: 0, 10: 0, 18: 1, 25: 1, 31: 2, 38: 2, 44: 3, 49: 3, 53: 4 });
const DEFAULT_MIX = 'humanFighter:18,humanMystic:4,elfFighter:16,elfMystic:6,darkFighter:17,darkMystic:6,orcFighter:16,orcMystic:5,dwarf:12';

function parseMix(text) {
    const weights = new Map();
    for (const entry of String(text || '').split(',')) {
        if (!entry.trim()) continue;
        const [name, value] = entry.split(':').map(part => part.trim());
        const weight = Number(value);
        if (!Object.hasOwn(CLASS_NAMES, name) || !(weight >= 0)) throw new Error(`invalid classMix entry "${entry.trim()}"`);
        weights.set(CLASS_NAMES[name], weight);
    }
    if (![...weights.values()].some(weight => weight > 0)) throw new Error('classMix has no positive weight');
    return weights;
}

// The weight of each starting class (class id -> weight; a class left out: 0). A
// malformed table is counted (FailureLog) and the default mix taken. Kept per text.
let mixText = null, mix = null;
function classWeights(text = Config.classMix) {
    if (text === mixText) return mix;
    try { mix = parseMix(text); } catch (error) { FailureLog.note('population.class_mix', error); mix = parseMix(DEFAULT_MIX); }
    mixText = text;
    return mix;
}

// Each race's share of new bots (race index -> share), the sum of its classes' weights.
function raceShares(weights = classWeights()) {
    const shares = [0, 0, 0, 0, 0];
    let total = 0;
    for (const [classId, weight] of weights) { shares[RACE_OF[classId]] += weight; total += weight; }
    return shares.map(share => share / total);
}

function pick(values, weights, seed, salt) {
    let roll = Types.random(seed, salt) * weights.reduce((sum, weight) => sum + weight, 0);
    let index = 0;
    while (index < values.length - 1 && roll >= weights[index]) roll -= weights[index++];
    return values[index];
}

function deficit(count, target) {
    return Math.max(0.03, 1 - Number(count || 0) / Math.max(1, target));
}

// The existing wave chooses the starter region (its share: raceShares). Within that
// region choose a class first, by its share of the region's classMix weight and its
// current deficit, then a persona type its class may take (BotPersonaTypes.chooseType:
// type share, deficit and circle); only the existing dwarf/wealth constraints are hard.
function choose(pool, seed, { typeCounts = {}, classCounts = {}, total = 1, classTotal = total, weights = classWeights() } = {}) {
    if (!pool?.length) throw new Error('empty_intake_class_pool');
    const poolWeight = pool.reduce((sum, profile) => sum + (weights.get(profile.classId) || 0), 0);
    const shareOf = profile => poolWeight > 0 ? (weights.get(profile.classId) || 0) / poolWeight : 1 / pool.length;
    const profile = pick(pool, pool.map((entry) => shareOf(entry)
        * deficit(classCounts[entry.classId], shareOf(entry) * classTotal)), seed, 'intake-class');
    return { ...profile, archetype: Types.chooseType(profile.classId, seed, typeCounts, total, { salt: 'intake-type' }) };
}

function classCounts(states, progression) {
    const roots = new Set(Object.keys(progression.firstProfMap).map(Number));
    const counts = {};
    for (const state of states || []) {
        if (String(state.accountName || '').startsWith('bot_craft_') || state.stats?.craftService === true) continue;
        const id = Number(state.stats?.classId ?? state.classId);
        if (!Number.isInteger(id)) continue;
        const base = progression.lineage(id).find((entry) => roots.has(entry));
        if (base !== undefined) counts[base] = (counts[base] || 0) + 1;
    }
    return counts;
}

module.exports = { choose, classCounts, classWeights, raceShares, CLASS_NAMES, DEFAULT_MIX };
