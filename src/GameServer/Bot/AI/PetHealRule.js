'use strict';

// Owner: when a summoner heals its pet, hot (SummonerTactics.combatAction)
// and cold (BackgroundResolver) alike. The summoner keeps its pet alive as a
// party member (docs/game-decisions.md, 10-30): it heals the pet below
// PET_HEAL_BELOW of its HP, in a fight and between fights.

const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

const PET_HEAL_BELOW = 0.7;

function wantsHeal(hp, maxHp) {
    return Number(maxHp) > 0 && Number(hp) > 0 && Number(hp) / Number(maxHp) < PET_HEAL_BELOW;
}

// A skill that heals the caster's pet (Servitor Heal; not Servitor Cure,
// a cleanse): read by meaning, a hot skill or a cold skill record alike.
function isPetHeal(skill) {
    if (!skill || skill.passive === true || skill.fetchPassive?.() === true) return false;
    const semantic = skill.fetchSemantic?.() || C4SkillRules.resolveCached(skill);
    return semantic.skillType === C4SkillRules.HEAL && semantic.target === 'pet';
}

module.exports = { PET_HEAL_BELOW, wantsHeal, isPetHeal };
