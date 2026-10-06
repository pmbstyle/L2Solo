'use strict';

const Types = require('../AI/BotPersonaTypes');

function pick(values, weights, seed, salt) {
    let roll = Types.random(seed, salt) * weights.reduce((sum, weight) => sum + weight, 0);
    let index = 0;
    while (index < values.length - 1 && roll >= weights[index]) roll -= weights[index++];
    return values[index];
}

function deficit(count, target) {
    return Math.max(0.03, 1 - Number(count || 0) / Math.max(1, target));
}

// The existing wave chooses the starter region. Within that region choose a
// persona type first, then a class from its circle, both by current deficit.
// Circles stay weights; only the existing dwarf/wealth constraints are hard.
function choose(pool, seed, { typeCounts = {}, classCounts = {}, total = 1, classTotal = total } = {}) {
    if (!pool?.length) throw new Error('empty_intake_class_pool');
    const typeIds = Types.TYPE_IDS.filter((id) => pool.some((profile) => Types.candidates(profile.classId).includes(id)));
    const typeId = pick(typeIds, typeIds.map((id) => Types.TYPES[id].share
        * deficit(typeCounts[id], Types.TYPES[id].share * total)), seed, 'intake-type');
    const candidates = pool.filter((profile) => Types.candidates(profile.classId).includes(typeId));
    const classShare = 1 / candidates.length;
    const profile = pick(candidates, candidates.map((entry) => (
        (Types.inCircle(typeId, entry.classId) ? 1 : 0.1)
        * deficit(classCounts[entry.classId], classShare * classTotal)
    )), seed, 'intake-class');
    return { ...profile, archetype: typeId };
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

module.exports = { choose, classCounts };
