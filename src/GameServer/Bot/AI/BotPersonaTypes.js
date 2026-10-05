'use strict';

// Persona types (market-sim step 3.1, N6a): a fixed table, pure functions, no
// game state. Each type has a drive, a share of the world, a circle of class
// families it fits (a weight, not a ban), trait centres and inclination
// centres. A bot's traits and inclinations are its type's centres plus a
// triangular spread of +-0.2, deterministic by the bot's seed.

const TRAITS = Object.freeze(['sociability', 'commitment', 'caution', 'ambition', 'assertiveness', 'empathy', 'resilience']);
const INCLINATIONS = Object.freeze(['pvp', 'justice', 'speculation']);
const SPREAD = 0.2;
const OUT_OF_CIRCLE = 0.1;
// The smallest deficit weight, so that a type over its share stays possible.
const MIN_DEFICIT = 0.03;

const COMBAT = Object.freeze(['melee', 'tank', 'dagger', 'archer', 'nuker', 'summoner', 'healer', 'buffer', 'bard']);
const ALL = Object.freeze([...COMBAT, 'spoiler', 'crafter']);

function type(drive, share, circle, centres, inclinations = {}) {
    const [sociability, commitment, caution, ambition, assertiveness, empathy, resilience] = centres;
    return Object.freeze({
        drive,
        share,
        circle: Object.freeze([...circle]),
        traits: Object.freeze({ sociability, commitment, caution, ambition, assertiveness, empathy, resilience }),
        inclinations: Object.freeze({ pvp: 0.15, justice: 0.10, speculation: 0.10, ...inclinations })
    });
}

// Trait centres in TRAITS order. The six author archetypes keep the author's
// centres (BotPersona v1).
const TYPES = Object.freeze({
    steady_achiever: type('progression', 0.110, COMBAT, [0.48, 0.65, 0.60, 0.78, 0.53, 0.55, 0.68]),
    competitive_climber: type('progression', 0.100, ['melee', 'dagger', 'archer', 'nuker'],
        [0.60, 0.40, 0.38, 0.88, 0.80, 0.35, 0.68], { pvp: 0.45 }),
    brawler: type('progression', 0.065, ['melee', 'dagger', 'nuker'],
        [0.50, 0.45, 0.22, 0.80, 0.88, 0.25, 0.65], { pvp: 0.85 }),
    lone_wolf: type('progression', 0.058, ['summoner', 'archer'], [0.18, 0.55, 0.55, 0.70, 0.45, 0.40, 0.85]),
    pragmatic_earner: type('wealth', 0.140, ALL.filter((family) => family !== 'crafter'),
        [0.36, 0.45, 0.62, 0.78, 0.48, 0.38, 0.72], { speculation: 0.45 }),
    patient_crafter: type('wealth', 0.120, ['crafter'], [0.42, 0.62, 0.72, 0.60, 0.33, 0.64, 0.75], { speculation: 0.25 }),
    speculator: type('wealth', 0.074, ALL, [0.45, 0.35, 0.25, 0.88, 0.62, 0.32, 0.60], { speculation: 0.85 }),
    steadfast_helper: type('social', 0.095, ['healer', 'buffer', 'bard'],
        [0.72, 0.86, 0.64, 0.56, 0.46, 0.90, 0.75], { justice: 0.35 }),
    party_regular: type('social', 0.105, ['healer', 'buffer', 'bard'], [0.82, 0.66, 0.48, 0.58, 0.55, 0.66, 0.62]),
    clan_loyalist: type('social', 0.070, ['tank', 'melee', 'healer', 'buffer', 'bard'],
        [0.70, 0.90, 0.50, 0.62, 0.74, 0.60, 0.70], { justice: 0.40 }),
    justice_keeper: type('social', 0.063, ['tank', 'melee', 'dagger', 'archer', 'nuker'],
        [0.60, 0.70, 0.30, 0.55, 0.76, 0.84, 0.68], { pvp: 0.40, justice: 0.85 })
});
const TYPE_IDS = Object.freeze(Object.keys(TYPES));

// Class families by C4 class id. A base class (before its profession) belongs
// to every family its professions lead to.
const CLASS_FAMILIES = (() => {
    const families = {};
    const put = (family, ids) => ids.forEach((id) => { families[id] = [family]; });
    put('melee', [1, 2, 3, 45, 46, 47, 48, 88, 89, 113, 114]);
    put('tank', [4, 5, 6, 20, 33, 90, 91, 99, 106]);
    put('dagger', [8, 23, 36, 93, 101, 108]);
    put('archer', [9, 24, 37, 92, 102, 109]);
    put('nuker', [12, 13, 27, 40, 94, 95, 103, 110]);
    put('summoner', [14, 28, 41, 96, 104, 111]);
    put('healer', [16, 29, 30, 42, 43, 97, 105, 112]);
    put('buffer', [17, 50, 51, 52, 98, 115, 116]);
    put('bard', [21, 34, 100, 107]);
    put('spoiler', [54, 55, 117]);
    put('crafter', [56, 57, 118]);
    const bases = {
        0: ['melee', 'tank', 'dagger', 'archer'], 10: ['nuker', 'summoner', 'healer', 'buffer'],
        18: ['tank', 'bard', 'dagger', 'archer'], 25: ['nuker', 'summoner', 'healer'],
        31: ['tank', 'bard', 'dagger', 'archer'], 38: ['nuker', 'summoner', 'healer'],
        44: ['melee'], 49: ['buffer'], 53: ['spoiler', 'crafter'],
        7: ['dagger', 'archer'], 22: ['dagger', 'archer'], 35: ['dagger', 'archer'],
        11: ['nuker', 'summoner'], 26: ['nuker', 'summoner'], 39: ['nuker', 'summoner'],
        19: ['tank', 'bard'], 32: ['tank', 'bard'], 15: ['healer', 'buffer']
    };
    Object.entries(bases).forEach(([id, list]) => { families[id] = list; });
    return Object.freeze(Object.fromEntries(Object.entries(families).map(([id, list]) => [id, Object.freeze(list)])));
})();
const DWARF_CLASS_IDS = new Set([53, 54, 55, 56, 57, 117, 118]);

// The author's seed hash (BotPersona v1), unchanged.
function hash(seed, salt = '') {
    let value = 2166136261;
    const source = `${seed}:${salt}`;
    for (let index = 0; index < source.length; index++) {
        value ^= source.charCodeAt(index);
        value = Math.imul(value, 16777619);
    }
    value += value << 13;
    value ^= value >>> 7;
    value += value << 3;
    value ^= value >>> 17;
    value += value << 5;
    return value >>> 0;
}

function random(seed, salt) { return hash(seed, salt) / 4294967296; }

function familiesOf(classId) { return CLASS_FAMILIES[Number(classId)] || []; }
function isDwarf(classId) { return DWARF_CLASS_IDS.has(Number(classId)); }

function inCircle(typeId, classId) {
    const families = familiesOf(classId);
    return TYPES[typeId].circle.some((family) => families.includes(family));
}

// The types a bot of this class may take: a dwarf only a wealth type, only a
// dwarf the crafter type; drive (optional) narrows to one drive.
function candidates(classId, drive = null) {
    const dwarf = isDwarf(classId);
    return TYPE_IDS.filter((id) => {
        if (dwarf && TYPES[id].drive !== 'wealth') return false;
        if (!dwarf && id === 'patient_crafter') return false;
        return !drive || TYPES[id].drive === drive;
    });
}

// The type for one bot by the deficit against the target shares: weight =
// circle weight x share x max(0.03, 1 - count / (share x total)), picked by
// the seed. counts: bots per type so far; total: the population the shares
// are of.
function chooseType(classId, seed, counts = {}, total = 1, { drive = null, salt = 'type' } = {}) {
    const ids = candidates(classId, drive);
    const weights = ids.map((id) => {
        const target = Math.max(1, TYPES[id].share * total);
        const deficit = Math.max(MIN_DEFICIT, 1 - Number(counts[id] || 0) / target);
        return (inCircle(id, classId) ? 1 : OUT_OF_CIRCLE) * TYPES[id].share * deficit;
    });
    let roll = random(seed, salt) * weights.reduce((sum, weight) => sum + weight, 0);
    let index = 0;
    while (roll >= weights[index] && index < weights.length - 1) roll -= weights[index++];
    return ids[index];
}

// Centre + (a + b - 1) x 0.2 with a, b uniform by the seed: a triangular
// spread of +-0.2, clamped to 0..1 and rounded to 0.01. salt re-rolls.
function rollValues(centres, names, prefix, seed, salt = '') {
    return Object.fromEntries(names.map((name) => {
        const spread = (random(seed, `${prefix}:${name}:a${salt}`) + random(seed, `${prefix}:${name}:b${salt}`) - 1) * SPREAD;
        return [name, Math.round(Math.max(0, Math.min(1, centres[name] + spread)) * 100) / 100];
    }));
}

function rollTraits(typeId, seed, salt = '') { return rollValues(TYPES[typeId].traits, TRAITS, 't', seed, salt); }
function rollInclinations(typeId, seed, salt = '') { return rollValues(TYPES[typeId].inclinations, INCLINATIONS, 'i', seed, salt); }

// Combat talents (combat-skills brief B): 0.5 + 0.5 x the mean of two traits.
function talents(traits) {
    const talent = (a, b) => 0.5 + 0.25 * (traits[a] + traits[b]);
    return {
        offense: talent('assertiveness', 'ambition'),
        defence: talent('caution', 'resilience'),
        support: talent('empathy', 'sociability')
    };
}

// Market understanding (N45): how exactly a bot reads prices and demand, one
// number from 0 to 1, fixed at creation: its wealth motive, speculation and
// caution, plus one roll of its own (+-0.15). The error of its price guess
// starts at 3% + 17% x (1 - understanding), then uses shared learning.
function understanding(drive, traits, inclinations, characterId) {
    const TendencyRoll = require('./TendencyRoll');
    const centre = 0.35 * (drive === 'wealth' ? 1 : 0) + 0.45 * Number(inclinations?.speculation || 0)
        + 0.2 * Number(traits?.caution || 0);
    return Math.max(0, Math.min(1, centre + 0.3 * (TendencyRoll.roll('n45s', Number(characterId) || 0) - 0.5)));
}

module.exports = {
    TRAITS,
    INCLINATIONS,
    TYPES,
    TYPE_IDS,
    CLASS_FAMILIES,
    hash,
    random,
    familiesOf,
    isDwarf,
    inCircle,
    candidates,
    chooseType,
    rollTraits,
    rollInclinations,
    talents,
    understanding
};
