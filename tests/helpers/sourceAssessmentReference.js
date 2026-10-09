'use strict';
// Native assessment from 9318ccab; adds only a test computation counter.
module.exports = `function partyNeedAssessmentForSource(state = {}, source = {}) {
    if (source?.sourceKind === 'raid' || source?.raidBoss === true) {
        return { need: 'required', reason: 'raid_roster_required' };
    }
    assessmentComputations++;
    const readiness = combatReadiness(state);
    const targetLevel = Number(source?.npcLevel || source?.spotLevel || Infinity);
    const margin = readiness.effectiveLevel - targetLevel;

    // A support with no weapon/armour cannot be treated as a safe solo farmer,
    // even when the level arithmetic happens to look favourable.  This is a
    // hard party need, while a normally equipped bot near the target level can
    // still progress alone and merely advertise a preferred party.
    const unpreparedSupport = ['healer', 'buffer'].includes(readiness.role)
        && readiness.armorCount < 2;
    if (!readiness.hasWeapon) return { need: 'required', reason: 'missing_weapon' };
    if (unpreparedSupport) return { need: 'required', reason: 'unprepared_support' };
    if (margin < -2) return { need: 'required', reason: 'underleveled' };
    if (margin < 0) return { need: 'preferred', reason: 'tight_level_margin' };
    return { need: 'solo_ok', reason: 'solo_ready' };
}
`;
