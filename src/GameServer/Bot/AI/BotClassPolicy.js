const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Progression = invoke('GameServer/ClassProgression');
const Equipment = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const tree = require('../../../../data/Skills/Tree/tree.json');
const Diagnostics = require('../Economy/EconomyDiagnostics');

// Mechanics come from the C4 tree. These small preferences are tunable bot
// decisions, not claims about an optimal player rotation. No SA assumptions.
const learning = Progression.learningLevels(tree);

function classIdOf(actor) {
    const raw = Roles.classIdOf(actor) ?? actor?.template?.classId;
    return raw === null || raw === undefined || raw === '' ? null : Number(raw);
}

function hasSkill(actor, skillId, level) {
    // A live actor's owned skills take precedence over theoretical training.
    if (actor?.skillset) {
        const skills = actor.skillset.fetchSkills?.() || actor.skillset.skills;
        if (Array.isArray(skills)) return skills.some(skill => Number(skill.fetchSelfId?.() ?? skill.selfId) === skillId);
        return !!actor.skillset.fetchSkill?.(skillId);
    }
    const availableAt = learning.get(classIdOf(actor))?.get(skillId);
    return availableAt !== undefined && availableAt <= Number(level ?? actor?.fetchLevel?.() ?? actor?.level ?? actor?.stats?.level ?? 1);
}

// A hot bot in a background party fights in party mode only while another
// member lives beside it: alone, it fights solo, as the cold fight's party of
// one does (BackgroundResolver.coldBotTurn, T126).
function hotPartyAlone(session) {
    // lazy: worker HotBackgroundParty loads the live world; only a hot session reaches here.
    const roster = invoke('GameServer/Bot/AI/HotBackgroundParty').roster(session);
    // A party not hot (yet) has no roster: it keeps the party mode it was given.
    if (!roster.length) return false;
    const selfId = session.actor?.fetchId?.();
    return !roster.some((member) => member.actor && member.actor.fetchId() !== selfId
        && !member.actor.state?.fetchDead?.() && !member.actor.isDead?.());
}

function modeFor(actor, context = {}) {
    if (['solo_pve', 'party_pve', 'solo_pvp', 'party_pvp'].includes(context.mode)) return context.mode;
    const session = context.session || actor?.session;
    let party = context.party === true || context.mode === 'party' || context.mode === 'duo'
        || !!actor?.party?.partyId || session?.partyCompanion === true;
    if (!party && session?.hotBackgroundPartyId) {
        party = !hotPartyAlone(session);
        // class_mode:hot_party_alone: how often a hot party of one fights solo; only while diagnostics count.
        if (!party && Diagnostics.active()) Diagnostics.count('class_mode', 'hot_party_alone', 'solo');
    }
    return `${party ? 'party' : 'solo'}_${context.pvp === true ? 'pvp' : 'pve'}`;
}

function profileFor(actor, context = {}) {
    const classId = classIdOf(actor);
    const role = Roles.inferRole(actor);
    const base = Progression.getThirdClass(classId)?.parentClassId ?? classId;
    const mode = modeFor(actor, context);
    const party = mode.startsWith('party');
    const pvp = mode.endsWith('pvp');
    const support = role === 'healer' || role === 'buffer';
    const manaReserve = support ? (party ? (pvp ? 0.30 : 0.45) : 0.25)
        : role === 'mage' ? 0 : pvp ? 0 : role === 'tank' && party ? 0.20 : 0.10;
    return {
        classId, supported: learning.has(classId), role, mode, manaReserve,
        purpose: [21, 34].includes(base) ? 'party_music' : Roles.isSummoner(actor) ? 'servitor'
            : role === 'healer' ? (hasSkill(actor, 1013, context.level) ? 'heal_and_recharge' : 'heal')
                : role === 'buffer' ? 'buff_and_sustain' : role,
        equipment: Equipment.profileFor(role, classId)
    };
}

function offensivePreference(actor, target, skill, context = {}) {
    const profile = context.classProfile || profileFor(actor, context);
    const reasons = [`class_mode:${profile.mode}`, `class_purpose:${profile.purpose}`];
    let score = 0;
    const semantic = skill.fetchSemantic?.() || {};
    if (semantic.skillType === 'drain' || skill.fetchSkillType?.() === 'drain') {
        const missing = Number(actor.fetchMaxHp?.() || 0) - Number(actor.fetchHp?.() || 0);
        score += missing > 0 ? 18 : -12;
        reasons.push(missing > 0 ? 'drain_recovers_hp' : 'drain_no_missing_hp');
    }
    if (profile.purpose === 'servitor' && actor.summon && !actor.summon.isDead?.()) {
        score -= Math.min(20, Math.max(0, Number(skill.fetchConsumedMp?.()) || 0));
        reasons.push('reserve_for_servitor');
    }
    return { score, reasons, profile };
}

function buffUseful(actor, effect) {
    const role = Roles.inferRole(actor);
    const base = Progression.getThirdClass(classIdOf(actor))?.parentClassId ?? classIdOf(actor);
    const meleeSupport = [21, 34, 49, 50, 51, 52].includes(base);
    const physical = !['mage', 'healer', 'buffer'].includes(role) || meleeSupport;
    if (effect === 'vampiric_rage') return physical && role !== 'archer'
        && actor?.backpack?.fetchTotalWeaponKind?.() !== 'Weapon.Bow';
    if (['might', 'holy_weapon', 'focus', 'haste', 'guidance', 'death_whisper',
        'power_of_paagrio', 'eye_of_paagrio', 'chant_of_fury', 'chant_of_rage'].includes(effect)) return physical;
    if (['empower', 'acumen', 'concentration', 'wild_magic', 'blessed_soul',
        'soul_of_paagrio', 'wisdom_of_paagrio'].includes(effect)) {
        return ['mage', 'healer', 'buffer'].includes(role) && ![21, 34].includes(base);
    }
    return null;
}

module.exports = { classIdOf, hasSkill, modeFor, profileFor, offensivePreference, buffUseful };
