const ClassProgression = invoke('GameServer/ClassProgression');

function stableNumber(value) {
    let hash = 2166136261;
    for (const character of String(value ?? 0)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    // FNV is a good stable accumulator, but its low bit remains correlated
    // for nearby numeric ids with similar suffixes. Avalanche the result so
    // first- and second-profession decisions stay independent.
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^ (hash >>> 16)) >>> 0;
}

function pick(options, seed, stage, currentClassId) {
    if (!options?.length) return null;
    const branchSeed = `${seed ?? 0}:${stage}:${currentClassId}`;
    return options[stableNumber(branchSeed) % options.length];
}

function nextClass(classId, level, seed) {
    const current = Number(classId);
    const currentLevel = Number(level || 1);
    if (currentLevel >= 20 && ClassProgression.firstProfMap[current]) {
        return pick(ClassProgression.firstProfMap[current], seed, 'first', current);
    }
    if (currentLevel >= 40 && ClassProgression.secondProfMap[current]) {
        return pick(ClassProgression.secondProfMap[current], seed, 'second', current);
    }
    if (currentLevel >= 76) {
        return Number(Object.entries(ClassProgression.thirdClasses)
            .find(([, entry]) => Number(entry.parentClassId) === current)?.[0]) || null;
    }
    return null;
}

function plan({ classId, level, seed } = {}) {
    let resolvedClassId = Number(classId);
    const transitions = [];
    if (!Number.isFinite(resolvedClassId)) return { classId: resolvedClassId, transitions };
    for (let target = nextClass(resolvedClassId, level, seed); target; target = nextClass(resolvedClassId, level, seed)) {
        resolvedClassId = target;
        transitions.push(target);
    }
    return { classId: resolvedClassId, transitions };
}

async function reconcile({ characterId, classId, level, seed = characterId } = {}) {
    const Database = invoke('Database');
    const Skillset = invoke('GameServer/Actor/Skillset');
    const id = Number(characterId);
    let resolvedClassId = Number(classId);
    const transitions = [];
    if (!id || !Number.isFinite(resolvedClassId)) return { classId: resolvedClassId, transitions };

    // The bot may have accumulated levels while cold.  Award its current tree
    // first, then walk every profession threshold it has already passed.
    const skillset = new Skillset();
    await skillset.awardSkills(id, resolvedClassId, level);
    for (let target = nextClass(resolvedClassId, level, seed); target; target = nextClass(resolvedClassId, level, seed)) {
        await Database.updateCharacterClassId(id, target);
        resolvedClassId = target;
        transitions.push(target);
        await skillset.awardSkills(id, resolvedClassId, level);
    }

    return { classId: resolvedClassId, transitions };
}

module.exports = { nextClass, plan, reconcile };
