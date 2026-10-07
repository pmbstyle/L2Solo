'use strict';
const DataCache = invoke('GameServer/DataCache');
const ClassProgression = invoke('GameServer/ClassProgression');

// Native tree projection is independent of NpcSkills/Model.Skill/network.
// These are the original ColdCombatProfile tree bodies, shared by both paths.
function number(value, fallback = 0) {
    const resolved = Number(value);
    return Number.isFinite(resolved) ? resolved : fallback;
}

const FIRST_CLASS_TO_BASE = new Map(
    Object.entries(ClassProgression.firstProfMap)
        .flatMap(([baseClassId, classIds]) => classIds.map((classId) => [number(classId), number(baseClassId)]))
);
const SECOND_CLASS_TO_FIRST = new Map(
    Object.entries(ClassProgression.secondProfMap)
        .flatMap(([firstClassId, classIds]) => classIds.map((classId) => [number(classId), number(firstClassId)]))
);

function parentClassId(classId) {
    const normalized = number(classId);
    const thirdParent = number(ClassProgression.getThirdClass(normalized)?.parentClassId, NaN);
    if (Number.isFinite(thirdParent)) return thirdParent;
    return SECOND_CLASS_TO_FIRST.get(normalized)
        ?? FIRST_CLASS_TO_BASE.get(normalized)
        ?? null;
}

function classProgressionIds(classId) {
    const ids = [];
    const seen = new Set();
    let current = number(classId);
    while (Number.isFinite(current) && current >= 0 && !seen.has(current)) {
        seen.add(current);
        ids.unshift(current);
        const parent = parentClassId(current);
        if (parent === null || parent === current) break;
        current = parent;
    }
    return ids;
}

function skillTreeEntries(classId) {
    const entries = new Map();
    classProgressionIds(classId).forEach((id) => {
        const tree = (DataCache.skillTree || []).find((entry) => number(entry.classId) === id);
        (tree?.skills || []).forEach((entry) => {
            const selfId = number(entry.selfId);
            const previous = entries.get(selfId);
            if (!previous) {
                entries.set(selfId, entry);
                return;
            }

            const levels = new Map((previous.levels || []).map((row) => [number(row.level), row]));
            (entry.levels || []).forEach((row) => levels.set(number(row.level), row));
            entries.set(selfId, { ...previous, ...entry, levels: [...levels.values()] });
        });
    });
    return [...entries.values()];
}

// The highest level row of a tree entry that a character of `level` has learned.
function learnedTreeRow(entry, level) {
    return (entry.levels || []).filter((row) => number(row.pLevel) <= level).at(-1);
}

// The level of one skill a class line knows at a character level, 0 if none.
function treeSkillLevel(classId, level, skillId) {
    const entry = skillTreeEntries(classId).find((candidate) => number(candidate.selfId) === number(skillId));
    return entry ? number(learnedTreeRow(entry, number(level))?.level) : 0;
}

module.exports = { classProgressionIds, skillTreeEntries, learnedTreeRow, treeSkillLevel };
