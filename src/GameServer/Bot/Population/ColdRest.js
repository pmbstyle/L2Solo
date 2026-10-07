const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');

// ARCH-NOTE: native FirstPrice needs seated recovery time in the clan worker.
// Share the resolver's unchanged calculation without its ChargeLifecycle/network
// imports; the authored regeneration and class tables arrive once per worker.

function midpointBand(levelBand) {
    if (!levelBand) return 1;
    const parts = String(levelBand).split('-').map((value) => Number(value));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return Number(parts[0]) || 1;
    return Math.round((parts[0] + parts[1]) / 2);
}

function coldPassiveRegenAdd(state, skillId, stat) {
    const classId = Number(state.stats?.classId ?? state.classId);
    const skill = (DataCache.skillTree || []).find((tree) => Number(tree.classId) === classId)?.skills
        ?.find((entry) => Number(entry.selfId) === skillId);
    const level = Number(state.level || midpointBand(state.levelBand));
    const skillLevel = (skill?.levels || [])
        .filter((entry) => Number(entry.pLevel) <= level)
        .reduce((highest, entry) => Math.max(highest, Number(entry.level) || 0), 0);
    if (!skillLevel) return 0;

    return Number(C4SkillRules.resolve({ selfId: skillId, level: skillLevel }).stats?.[stat]) || 0;
}

function coldRestRegenPerTick(state, options = {}) {
    const level = Math.max(1, Number(state.level || midpointBand(state.levelBand)) || 1);
    const classId = Number(state.stats?.classId ?? state.classId);
    const template = (DataCache.classTemplates || []).find((entry) => Number(entry.classId) === classId) || {};
    const baseStats = template.base || {};
    const hpBase = Number(DataCache.revitalize?.hp?.[level]) || 0;
    const mpBase = Number(DataCache.revitalize?.mp?.[level]) || 0;
    const hp = ((hpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.CON(Number(baseStats.con) || 1))
        + coldPassiveRegenAdd(state, 212, 'regHpAdd')) * 1.5;
    const mp = ((mpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.MEN(Number(baseStats.men) || 1))
        + coldPassiveRegenAdd(state, 229, 'regMpAdd')) * 1.5;

    return { hp: Math.max(0, hp) * (options.hpMultiplier || 1), mp: Math.max(0, mp) * (options.mpMultiplier || 1) };
}

function requiresManaRecovery(state, options = {}) {
    if (typeof options.requireMana === 'boolean') return options.requireMana;
    return RestPolicy.restsForMana(state, options.party === true);
}

function estimateRestMs(state, vitals, options = {}) {
    const maxHp = Number(vitals.maxHp || vitals.hp || 1);
    const maxMp = Number(vitals.maxMp || vitals.mp || 1);
    const missingHp = Math.max(0, maxHp - Number(vitals.hp || 0));
    const missingMp = Math.max(0, maxMp - Number(vitals.mp || 0));
    const regen = coldRestRegenPerTick(state, options);
    const hpSeconds = missingHp / Math.max(0.01, regen.hp / 3);
    const mpSeconds = requiresManaRecovery(state, options)
        ? missingMp / Math.max(0.01, regen.mp / 3)
        : 0;

    return Math.round(Math.max(hpSeconds, mpSeconds, 8) * 1000);
}

module.exports = { coldRestRegenPerTick, requiresManaRecovery, estimateRestMs };
