const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const World = invoke('GameServer/World/World');

const PARTY_REVIVE_TIMEOUT_MS = 60000;
const RESURRECTION_SCROLL_SKILL_ID = 2014;
const PLAYER_RESURRECTION_SCROLLS = new Set([737, 3936, 3959]);

function isCompanionOf(session, leaderSession) {
    return !!(
        session?.actor &&
        session.followPlayerSession === leaderSession &&
        session.partyCompanion === true
    );
}

function partySessions(leaderSession) {
    if (!leaderSession?.actor) return [];
    const BotManager = invoke('GameServer/Bot/BotManager');
    return [leaderSession, ...(BotManager.sessions || []).filter((session) => isCompanionOf(session, leaderSession))];
}

function isAlive(session) {
    return !!session?.actor && session.actor.fetchIsOnline?.() === true && !session.actor.isDead?.();
}

function deadMembers(leaderSession) {
    return partySessions(leaderSession).filter((session) => (
        session?.actor?.fetchIsOnline?.() === true && session.actor.isDead?.()
    ));
}

function partyCombatInProgress(leaderSession) {
    if (PartyAwareness.findThreatTargetingParty(leaderSession)) return true;
    const members = partySessions(leaderSession);
    if (members
        .filter(isAlive)
        .some((session) => {
            const state = session.actor.state;
            return !!(state?.fetchCombats?.() || state?.fetchHits?.() || state?.fetchCasts?.());
        })) return true;

    // PartyAwareness intentionally ignores corpses. For resurrection that is
    // too narrow: a monster can keep its combat loop on a fallen party member
    // for a short time after the lethal hit, and a healer must not begin a
    // long resurrection cast in front of it.
    const partyIds = new Set(members.map((member) => member.actor?.fetchId?.()).filter(Boolean));
    return (World.npc?.spawns || []).some((npc) => (
        npc.fetchAttackable?.() === true &&
        npc.isDead?.() !== true &&
        npc.state?.fetchCombats?.() === true &&
        partyIds.has(npc.fetchDestId?.())
    ));
}

function learnedResurrectionSkills(actor) {
    return (actor?.skillset?.skills || [])
        .filter((skill) => skill && !skill.fetchPassive?.())
        .filter((skill) => skill.fetchSkillType?.() === C4SkillRules.RESURRECT)
        .filter((skill) => skill.fetchTargetKind?.() === 'corpse_player');
}

function resurrectionSkill(actor) {
    return learnedResurrectionSkills(actor)
        .filter((skill) => actor.canUseSkill?.(skill) !== false)
        .filter((skill) => Number(actor.fetchMp?.() || 0) >= Number(skill.fetchConsumedMp?.() || 0))
        .sort((a, b) => Number(b.fetchPower?.() || 0) - Number(a.fetchPower?.() || 0))[0] || null;
}

function resurrectionScrollSkill() {
    const source = (DataCache.skills || []).find((skill) => Number(skill.selfId) === RESURRECTION_SCROLL_SKILL_ID);
    if (!source) {
        // Bot AI may begin a hot-session tick while the datapack cache is
        // still warming. The C4 rules are keyed by selfId, so this sourced
        // fallback preserves the same native scroll cast without waiting for
        // a persistent inventory item.
        return new SkillModel({
            selfId: RESURRECTION_SCROLL_SKILL_ID,
            name: 'Scroll of resurrection',
            passive: false,
            spell: false,
            distance: 400,
            hitTime: 15000,
            reuse: 0,
            power: 1,
            mp: 0,
            hp: 0,
            itemId: 0,
            itemCount: 0,
            level: 1
        });
    }
    const level = Number(source.levels?.[0]?.level) || 1;
    const levelData = source.levels?.find((entry) => Number(entry.level) === level) || {};
    return new SkillModel({ ...utils.crushOb(source), ...levelData, level });
}

function playerCanResurrect(leaderSession) {
    const player = leaderSession?.actor;
    if (!isAlive(leaderSession)) return false;
    if (learnedResurrectionSkills(player).length > 0) return true;
    return (player.backpack?.fetchItems?.() || [])
        .some((item) => PLAYER_RESURRECTION_SCROLLS.has(Number(item.fetchSelfId?.())) && Number(item.fetchAmount?.() || 0) > 0);
}

function clearExpiredAttempt(leaderSession, now) {
    const attempt = leaderSession?.partyRevivalAttempt;
    if (attempt && now - Number(attempt.startedAt || 0) > 25000) {
        leaderSession.partyRevivalAttempt = null;
    }
}

function castScroll(session, actor, target, skill) {
    actor.select?.({ id: target.fetchId() });
    session.currentTargetId = target.fetchId();
    actor.automation.scheduleAction(session, actor, target, skill.fetchDistance(), () => {
        actor.attack.remoteHit(session, target, skill);
    });
}

function tick(session, leaderSession, Generics) {
    if (!isCompanionOf(session, leaderSession) || !isAlive(session)) return { handled: false };

    const now = Date.now();
    clearExpiredAttempt(leaderSession, now);
    const dead = deadMembers(leaderSession);
    if (dead.length === 0) {
        leaderSession.partyRevivalAttempt = null;
        return { handled: false, dead };
    }
    if (partyCombatInProgress(leaderSession)) return { handled: false, dead };

    const attempt = leaderSession.partyRevivalAttempt;
    if (attempt) return { handled: attempt.providerId === session.actor.fetchId(), waiting: true, targetId: attempt.targetId };

    const targetSession = dead.sort((a, b) => Number(a.actor.fetchId()) - Number(b.actor.fetchId()))[0];
    const providers = partySessions(leaderSession)
        .filter(isAlive)
        .filter((memberSession) => memberSession !== leaderSession)
        .filter((memberSession) => memberSession.actor !== session.actor || !session.actor.state?.fetchCasts?.());
    const skilled = providers
        .map((providerSession) => ({ session: providerSession, skill: resurrectionSkill(providerSession.actor) }))
        .filter((entry) => entry.skill)
        .sort((a, b) => Number(a.session.actor.fetchId()) - Number(b.session.actor.fetchId()))[0] || null;
    const provider = skilled?.session || providers.sort((a, b) => Number(a.actor.fetchId()) - Number(b.actor.fetchId()))[0] || null;
    if (!provider || provider !== session) return { handled: false, dead };

    const skill = skilled?.skill || resurrectionScrollSkill();
    if (!skill) return { handled: false, dead };

    leaderSession.partyRevivalAttempt = {
        providerId: session.actor.fetchId(),
        targetId: targetSession.actor.fetchId(),
        source: skilled ? 'skill' : 'scroll',
        startedAt: now
    };

    if (skilled) {
        session.currentTargetId = targetSession.actor.fetchId();
        session.actor.select?.({ id: targetSession.actor.fetchId() });
        Generics.skillExec(session, session.actor, {
            id: targetSession.actor.fetchId(),
            selfId: skill.fetchSelfId(),
            ctrl: false
        });
    } else {
        castScroll(session, session.actor, targetSession.actor, skill);
    }

    return {
        handled: true,
        target: targetSession.actor,
        source: skilled ? 'skill' : 'scroll'
    };
}

function shouldTownRespawn(leaderSession, deadSession, now = Date.now()) {
    if (!isCompanionOf(deadSession, leaderSession) || !leaderSession?.actor?.fetchIsOnline?.()) return true;

    const members = partySessions(leaderSession);
    const living = members.filter(isAlive);
    if (living.length === 0) return true;
    if (living.length === 1 && living[0] === leaderSession && !playerCanResurrect(leaderSession)) return true;

    return now - Number(deadSession.deathTimerStart || now) >= PARTY_REVIVE_TIMEOUT_MS;
}

module.exports = {
    PARTY_REVIVE_TIMEOUT_MS,
    partySessions,
    deadMembers,
    partyCombatInProgress,
    learnedResurrectionSkills,
    resurrectionSkill,
    playerCanResurrect,
    tick,
    shouldTownRespawn
};
