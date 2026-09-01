// C4/L2J party reward curve. The total reward grows with the eligible party,
// then is split by squared level rather than being divided equally.
const PARTY_EXP_SP_BONUS = [1, 1.30, 1.39, 1.50, 1.54, 1.58, 1.63, 1.67, 1.71];

function normalizedLevel(level) {
    return Math.max(1, Number(level || 1));
}

function partyBonus(memberCount) {
    const index = Math.max(0, Math.min(PARTY_EXP_SP_BONUS.length - 1, Number(memberCount || 1) - 1));
    return PARTY_EXP_SP_BONUS[index];
}

function validMemberIndexes(levels) {
    if (levels.length < 2) return levels.map((_, index) => index);
    const squaredLevelSum = levels.reduce((sum, level) => sum + normalizedLevel(level) ** 2, 0);
    const previousBonus = partyBonus(levels.length - 1);
    const currentBonus = partyBonus(levels.length);
    const cutoff = squaredLevelSum * (1 - (1 / (1 + currentBonus - previousBonus)));
    return levels.map((level, index) => ({ index, weight: normalizedLevel(level) ** 2 }))
        .filter((entry) => entry.weight >= cutoff)
        .map((entry) => entry.index);
}

function sharesForLevels(levels, exp, sp) {
    const validIndexes = validMemberIndexes(levels);
    if (validIndexes.length === 0) return [];
    const totalWeight = validIndexes.reduce((sum, index) => sum + normalizedLevel(levels[index]) ** 2, 0);
    const bonus = partyBonus(validIndexes.length);
    return validIndexes.map((index) => {
        const weight = normalizedLevel(levels[index]) ** 2 / totalWeight;
        return {
            index,
            exp: Math.max(0, Math.round(Number(exp || 0) * bonus * weight)),
            sp: Math.max(0, Math.round(Number(sp || 0) * bonus * weight))
        };
    });
}

module.exports = { PARTY_EXP_SP_BONUS, partyBonus, validMemberIndexes, sharesForLevels };
