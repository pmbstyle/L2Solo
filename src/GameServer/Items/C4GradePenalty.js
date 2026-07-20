const EffectStore = invoke('GameServer/Effects/EffectStore');
const ServerResponse = invoke('GameServer/Network/Response');

const RANKS = ['none', 'D', 'C', 'B', 'A', 'S'];
const EXPERTISE_SKILL_ID = 239;
const GRADE_PENALTY_SKILL_ID = 4267;
// C4's Grade Penalty always applies skill 4267 level 1.  The source computes
// the difference for the client status flag, but adds level 1 of the skill.
const GRADE_PENALTY_RATE = 0.22;

function rankIndex(rank) {
    return Math.max(0, RANKS.indexOf(String(rank || 'none').toUpperCase()));
}

function expertiseIndex(actor) {
    return Math.max(0, Number(actor?.skillset?.fetchSkill?.(EXPERTISE_SKILL_ID)?.fetchLevel?.()) || 0);
}

function equippedRank(actor) {
    return (actor?.backpack?.fetchItems?.() || [])
        .filter((item) => item?.fetchEquipped?.())
        .reduce((highest, item) => Math.max(highest, rankIndex(item.fetchRank?.())), 0);
}

function penalty(actor) {
    return Math.max(0, equippedRank(actor) - expertiseIndex(actor));
}

function effect() {
    return {
        key: 'grade_penalty',
        id: GRADE_PENALTY_SKILL_ID,
        level: 1,
        name: 'Grade Penalty',
        type: 'debuff',
        dispellable: false,
        stats: {
            pAtkSpdMul: GRADE_PENALTY_RATE,
            castSpdMul: GRADE_PENALTY_RATE,
            pEvasionMul: GRADE_PENALTY_RATE,
            expMul: GRADE_PENALTY_RATE,
            runSpdMul: GRADE_PENALTY_RATE,
            regHp: GRADE_PENALTY_RATE,
            regMp: GRADE_PENALTY_RATE,
            regCp: GRADE_PENALTY_RATE
        }
    };
}

function sync(actor) {
    if (!actor) return false;
    const next = penalty(actor);
    const previous = Number(actor.fetchExpertisePenalty?.()) || 0;

    if (next > 0) EffectStore.apply(actor, effect());
    else EffectStore.remove(actor, 'grade_penalty');

    if (previous === next) return false;
    actor.setExpertisePenalty?.(next);
    actor.session?.dataSendToMe?.(ServerResponse.etcStatusUpdate(actor));
    return true;
}

module.exports = { sync, penalty, expertiseIndex, equippedRank, rankIndex };
