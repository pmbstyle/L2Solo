// Intent only. Native/physical combat guards still own attack permission.
const RETRY_MS = 10 * 60000;
const NOTICE_RADIUS = 900;
const clamp = (n, low = 0, high = 1) => Math.max(low, Math.min(high, Number(n) || 0));
function evaluate(relation, persona = {}) {
    const no = reason => ({ chance: 0, reason });
    if (!relation?.ready) return no('memory_unloaded');
    if (['self', 'own', 'ally'].includes(relation.affiliation)) return no('protected_affiliation');
    const personal = relation.personal, feeling = relation.effective || personal;
    // A clan grievance can modulate a personal conflict, not invent one.
    if (!personal || personal.hostility < 12 || personal.trust > -5) return no('no_personal_grievance');
    if (!feeling || feeling.hostility < 24 || feeling.trust > -5 || feeling.affinity > 0) return no('grievance_cooled');
    const t = key => clamp(persona.traits?.[key] ?? 0.5);
    if (t('caution') >= 0.7 && t('assertiveness') <= 0.4 && t('empathy') >= 0.6) return no('avoids_pvp');
    const hostility = clamp((feeling.hostility - 12) / 48);
    const resentment = clamp(-(feeling.affinity + feeling.trust) / 60);
    const fear = clamp(feeling.fear / 30);
    const stage = relation.clanSocial?.selfDiscipline?.stage;
    const restraint = 1 - ({ concern: 0.2, warned: 0.4, probation: 0.7, expulsion_pending: 0.85 }[stage] || 0)
        * (t('commitment') + t('empathy')) / 2;
    const chance = clamp(0.04 + hostility * 0.22 + resentment * 0.1 + t('assertiveness') * 0.18
        - t('caution') * 0.12 - t('empathy') * 0.1 - t('resilience') * 0.08 - fear * 0.25, 0, 0.35) * restraint;
    return { chance, reason: chance > 0 ? 'personal_grievance' : 'restraint', hostility: feeling.hostility, fear: feeling.fear };
}
module.exports = { evaluate, RETRY_MS, NOTICE_RADIUS };
