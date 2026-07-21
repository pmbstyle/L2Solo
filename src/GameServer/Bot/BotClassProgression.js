const Database = invoke('Database');
const Skillset = invoke('GameServer/Actor/Skillset');
const ClassProgression = invoke('GameServer/ClassProgression');

function stableNumber(value) {
    return [...String(value || 0)].reduce((sum, character) => sum + character.charCodeAt(0), 0);
}

function pick(options, seed) {
    if (!options?.length) return null;
    return options[Math.abs(stableNumber(seed)) % options.length];
}

function nextClass(classId, level, seed) {
    const current = Number(classId);
    const currentLevel = Number(level || 1);
    if (currentLevel >= 20 && ClassProgression.firstProfMap[current]) {
        return pick(ClassProgression.firstProfMap[current], seed);
    }
    if (currentLevel >= 40 && ClassProgression.secondProfMap[current]) {
        return pick(ClassProgression.secondProfMap[current], seed);
    }
    if (currentLevel >= 76) {
        return Number(Object.entries(ClassProgression.thirdClasses)
            .find(([, entry]) => Number(entry.parentClassId) === current)?.[0]) || null;
    }
    return null;
}

async function reconcile({ characterId, classId, level, seed = characterId } = {}) {
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

module.exports = { nextClass, reconcile };
