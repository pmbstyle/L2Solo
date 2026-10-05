const assert = require('assert');

// Persona types (step 3.1, N6a): the table, the type choice by class and
// share, the triangular spread and the talents.
const Types = require('../src/GameServer/Bot/AI/BotPersonaTypes');

const ids = Types.TYPE_IDS;
assert.strictEqual(ids.length, 11);
const shareOf = (drive) => ids.filter((id) => Types.TYPES[id].drive === drive).reduce((sum, id) => sum + Types.TYPES[id].share, 0);
for (const drive of ['progression', 'wealth', 'social']) assert(Math.abs(shareOf(drive) - 1 / 3) < 0.002, `${drive} is a third of the world`);
// The author's six archetypes keep their centres.
assert.deepStrictEqual({ ...Types.TYPES.steady_achiever.traits },
    { sociability: 0.48, commitment: 0.65, caution: 0.60, ambition: 0.78, assertiveness: 0.53, empathy: 0.55, resilience: 0.68 });
assert.deepStrictEqual({ ...Types.TYPES.party_regular.traits },
    { sociability: 0.82, commitment: 0.66, caution: 0.48, ambition: 0.58, assertiveness: 0.55, empathy: 0.66, resilience: 0.62 });
// Inclination centres (brief, 2026-10-05).
const inclination = (name) => Object.fromEntries(ids.map((id) => [id, Types.TYPES[id].inclinations[name]]));
const others = (map, value) => Object.entries(map).filter(([, v]) => v === value).length;
assert.deepStrictEqual([inclination('pvp').brawler, inclination('pvp').competitive_climber, inclination('pvp').justice_keeper], [0.85, 0.45, 0.40]);
assert.strictEqual(others(inclination('pvp'), 0.15), 8);
assert.deepStrictEqual([inclination('justice').justice_keeper, inclination('justice').clan_loyalist, inclination('justice').steadfast_helper], [0.85, 0.40, 0.35]);
assert.strictEqual(others(inclination('justice'), 0.10), 8);
assert.deepStrictEqual([inclination('speculation').speculator, inclination('speculation').pragmatic_earner, inclination('speculation').patient_crafter], [0.85, 0.45, 0.25]);
assert.strictEqual(others(inclination('speculation'), 0.10), 8);

// Hard rules: a dwarf only a wealth type, the crafter type only a dwarf.
const classIds = Object.keys(Types.CLASS_FAMILIES).map(Number);
for (const classId of classIds) {
    for (let seed = 0; seed < 200; seed++) {
        const id = Types.chooseType(classId, String(seed), {}, 1700);
        if (Types.isDwarf(classId)) assert.strictEqual(Types.TYPES[id].drive, 'wealth', `dwarf class ${classId} got ${id}`);
        else assert.notStrictEqual(id, 'patient_crafter', `non-dwarf class ${classId} got the crafter type`);
    }
}

// Determinism and the spread: centre + triangular +-0.2, clamped, 0.01 steps.
assert.deepStrictEqual(Types.rollTraits('brawler', '123'), Types.rollTraits('brawler', '123'));
assert.notDeepStrictEqual(Types.rollTraits('brawler', '123'), Types.rollTraits('brawler', '123', ':1'), 'a salt re-rolls');
assert.strictEqual(Types.chooseType(12, '77', {}, 1700), Types.chooseType(12, '77', {}, 1700));
let near = 0, all = 0, sum = 0;
for (let seed = 0; seed < 3000; seed++) {
    const traits = Types.rollTraits('party_regular', String(seed));
    const inclinations = Types.rollInclinations('speculator', String(seed));
    for (const name of Types.TRAITS) {
        const offset = traits[name] - Types.TYPES.party_regular.traits[name];
        assert(traits[name] >= 0 && traits[name] <= 1 && Math.abs(offset) <= 0.2 + 1e-9, `${name} ${traits[name]}`);
        assert.strictEqual(Math.round(traits[name] * 100) / 100, traits[name]);
        near += Number(Math.abs(offset) <= 0.1 + 1e-9); all++; sum += offset;
    }
    for (const name of Types.INCLINATIONS) {
        assert(Math.abs(inclinations[name] - Types.TYPES.speculator.inclinations[name]) <= 0.2 + 1e-9 && inclinations[name] >= 0);
    }
}
// Triangular: 75% of the mass within half the range (uniform would give 50%).
assert(near / all > 0.72 && near / all < 0.78, `triangular spread ${near / all}`);
assert(Math.abs(sum / all) < 0.005, 'the spread is centred');

// Talents (combat-skills brief B): 0.5 + 0.5 x the mean of two traits.
assert.deepStrictEqual(Types.talents({ assertiveness: 0.8, ambition: 0.6, caution: 0.2, resilience: 0.4, empathy: 1, sociability: 0 }),
    { offense: 0.85, defence: 0.65, support: 0.75 });

// Shares on a synthetic new world (the author's race waves of 30, 1,700 bots).
const POOL = { 0: [0, 10], 1: [18, 25], 2: [31, 38], 3: [44, 49], 4: [53] };
const FIRST = { 0: [1, 4, 7], 10: [11, 15], 18: [19, 22], 25: [26, 29], 31: [32, 35], 38: [39, 42], 44: [45, 47], 49: [50, 51], 53: [54, 56] };
function world(atBaseClass) {
    const bots = [];
    for (let i = 0; i < 1700; i++) {
        const race = Math.floor(i / 30) % 5, pool = POOL[race], base = pool[Math.floor(i / 150) % pool.length];
        const profession = FIRST[base][Math.floor(Types.random(i, 'prof') * FIRST[base].length)];
        bots.push({ classId: atBaseClass ? base : profession, seed: String(7000000 + i) });
    }
    return bots;
}
function shares(bots, dwarvesFirst) {
    const counts = {};
    const order = dwarvesFirst ? [...bots].sort((a, b) => Number(Types.isDwarf(b.classId)) - Number(Types.isDwarf(a.classId))) : bots;
    for (const bot of order) {
        const id = Types.chooseType(bot.classId, bot.seed, counts, bots.length);
        counts[id] = (counts[id] || 0) + 1;
    }
    return Object.fromEntries(ids.map((id) => [id, (counts[id] || 0) / bots.length]));
}
// Classes fixed first, dwarves first (the migration): the brief's run (types-sim2,
// new world): every type within 1.5 points (rounded: 1.6), except the crafter (5.9%: half of
// the dwarves are spoilers) whose shortfall goes to the pragmatic earner (16.8%).
const fixed = shares(world(false), true);
for (const id of ids) {
    if (id === 'patient_crafter' || id === 'pragmatic_earner') continue;
    assert(Math.abs(fixed[id] - Types.TYPES[id].share) <= 0.016, `${id} ${fixed[id]}`);
}
assert.strictEqual(fixed.patient_crafter.toFixed(3), '0.059');
assert.strictEqual(fixed.pragmatic_earner.toFixed(3), '0.168');
// New bots one by one at their base class (the seeder): every type within 1.6 points.
const seeded = shares(world(true), false);
for (const id of ids) assert(Math.abs(seeded[id] - Types.TYPES[id].share) <= 0.016, `${id} ${seeded[id]}`);

console.log('Bot persona types checks passed');
