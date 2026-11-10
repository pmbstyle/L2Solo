// Intent only. Native/physical combat guards still own attack permission.
// The one PvP/revenge rule of a bot toward one character, both threads (cold revenge,
// hot revenge, the cold conflict's re-check): a grievance (a personal one, or a mutual
// clan war) weighed by persona and fear, and by what the attack costs in C4 standing.
const Config = require('../Bot/Population/PopulationConfig');
const { scaleChance, karmaCost } = require('./PvpAggression');
const Visible = require('./VisibleStrength');
const NOTICE_RADIUS = 900;
// A mutual clan war is a grievance of its own (C4: its kills cost no karma): the
// hostility it stands for when no personal one is stronger (ours).
const WAR_HOSTILITY = 0.5;
const clamp = (n, low = 0, high = 1) => Math.max(low, Math.min(high, Number(n) || 0));
// standing: { ownKarma, targetKarma, targetFlagged, war } (PvpAggression.karmaCost).
// A bot with karma starts no fight outside a mutual clan war: it washes its karma first
// (C9's karma wash); a war kill gives no karma in C4, so a red bot still meets its war
// enemies. A red target is free; a white one weighs being flagged and turning red.
// The cheap gates of the callers ask the same (startsNoFight).
const startsNoFight = ({ ownKarma = 0, war = false } = {}) => war !== true && Number(ownKarma) > 0;
function evaluate(relation, persona = {}, standing = {}) {
    const no = reason => ({ chance: 0, reason });
    if (!relation?.ready) return no('memory_unloaded');
    if (['self', 'own', 'ally'].includes(relation.affiliation)) return no('protected_affiliation');
    const war = standing.war === true;
    if (startsNoFight(standing)) return no('own_karma');
    const personal = relation.personal, feeling = relation.effective || personal;
    // A clan grievance can modulate a personal conflict, not invent one; a war can.
    const remembered = !!personal && personal.hostility >= 12 && personal.trust <= -5;
    const grievance = remembered && !!feeling && feeling.hostility >= 24 && feeling.trust <= -5 && feeling.affinity <= 0;
    if (!war && !remembered) return no('no_personal_grievance');
    if (!war && !grievance) return no('grievance_cooled');
    // A friend in the enemy clan is no enemy met.
    if (war && feeling && feeling.trust >= 5 && feeling.affinity > 0) return no('friend');
    const t = key => clamp(persona?.traits?.[key] ?? 0.5);
    const hostility = Math.max(war ? WAR_HOSTILITY : 0, clamp(((feeling?.hostility ?? 0) - 12) / 48));
    const resentment = clamp(-((feeling?.affinity ?? 0) + (feeling?.trust ?? 0)) / 60);
    const fear = Visible.fear(relation);
    const stage = relation.clanSocial?.selfDiscipline?.stage;
    const restraint = 1 - ({ concern: 0.2, warned: 0.4, probation: 0.7, expulsion_pending: 0.85 }[stage] || 0)
        * (t('commitment') + t('empathy')) / 2;
    const baseChance = clamp(0.04 + hostility * 0.22 + resentment * 0.1 + t('assertiveness') * 0.18
        - t('caution') * 0.12 - t('empathy') * 0.1 - t('resilience') * 0.08 - fear * 0.25, 0, 0.35) * restraint
        * (1 - karmaCost(persona, standing));
    const chance = scaleChance(baseChance, Config.pvpAggression);
    return { chance, reason: chance > 0 ? grievance ? 'personal_grievance' : 'clan_war' : 'restraint',
        hostility: feeling?.hostility ?? 0, fear: feeling?.fear ?? 0 };
}
module.exports = { evaluate, startsNoFight, NOTICE_RADIUS };
