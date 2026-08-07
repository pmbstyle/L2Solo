const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');

const PARTY_REVIVE_TIMEOUT_MS = 60000;
const PARTY_DEATH_FRUSTRATION_WINDOW_MS = 10 * 60 * 1000;
const PARTY_DEATH_WARNING_COUNT = 2;
const RESURRECTION_SCROLL_SKILL_ID = 2014;
const PLAYER_RESURRECTION_SCROLLS = new Set([737, 3936, 3959]);

function world() {
    return invoke('GameServer/World/World');
}

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
        session?.actor?.fetchIsOnline?.() === true &&
        session.actor.isDead?.()
    ));
}

function noteCompanionDeath(leaderSession, deadSession, now = Date.now()) {
    if (!isCompanionOf(deadSession, leaderSession)) return { count: 0, warning: false };
    const leaderId = Number(leaderSession.actor?.fetchId?.() || 0);
    const previous = deadSession.partyDeathFrustration;
    const sameLeader = Number(previous?.leaderId || 0) === leaderId;
    const deaths = (sameLeader ? previous?.deaths || [] : [])
        .map(Number)
        .filter((at) => now - at <= PARTY_DEATH_FRUSTRATION_WINDOW_MS);
    deaths.push(now);
    deadSession.partyDeathFrustration = { leaderId, deaths };
    const count = deaths.length;
    return {
        count,
        warning: count === PARTY_DEATH_WARNING_COUNT
    };
}

function partyCombatInProgress(leaderSession) {
    return PartyCombatState.isActive(leaderSession);
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

function clearExpiredAttempt(leaderSession, dead, now) {
    const attempt = leaderSession?.partyRevivalAttempt;
    const targetStillDead = dead.some((memberSession) => (
        Number(memberSession.actor?.fetchId?.()) === Number(attempt?.targetId)
    ));
    if (attempt && (!targetStillDead || now - Number(attempt.startedAt || 0) > 25000)) {
        leaderSession.partyRevivalAttempt = null;
    }
}

function castScroll(session, actor, target, skill) {
    actor.select?.({ id: target.fetchId() });
    session.currentTargetId = target.fetchId();
    invoke('GameServer/Bot/AI/BotPartyChat').expectSkillResult(session, {
        target,
        skill,
        kind: 'resurrection'
    });
    actor.automation.scheduleAction(session, actor, target, skill.fetchDistance(), () => {
        actor.attack.remoteHit(session, target, skill);
    });
}

function tick(session, leaderSession, Generics) {
    if (!isCompanionOf(session, leaderSession) || !isAlive(session)) return { handled: false };

    const now = Date.now();
    const dead = deadMembers(leaderSession);
    // A successful cast can revive its target while another party member is
    // still dead. Do not hold the old attempt until its timeout: the next
    // provider tick must immediately pick the next corpse.
    clearExpiredAttempt(leaderSession, dead, now);
    if (dead.length === 0) {
        leaderSession.partyRevivalAttempt = null;
        return { handled: false, dead };
    }
    const combat = PartyCombatState.combatState(leaderSession);
    if (combat.active) return { handled: false, dead, blockedBy: combat.reason, threat: combat.target };

    const attempt = leaderSession.partyRevivalAttempt;
    if (attempt) return { handled: attempt.providerId === session.actor.fetchId(), waiting: true, targetId: attempt.targetId };

    // The leader is the party's anchor.  Restore them first even if another
    // companion happens to have a lower character id.
    const targetSession = dead.sort((a, b) => (
        Number(b === leaderSession) - Number(a === leaderSession) ||
        Number(a.actor.fetchId()) - Number(b.actor.fetchId())
    ))[0];
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
        invoke('GameServer/Bot/AI/BotPartyChat').expectSkillResult(session, {
            target: targetSession.actor,
            skill,
            kind: 'resurrection'
        });
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

    // A resurrection provider cannot safely cast while the party is still
    // fighting. Pause the actual wait budget instead of letting wall-clock
    // time expire behind the fight and forcing an immediate town restart as
    // soon as combat ends.
    if (partyCombatInProgress(leaderSession)) {
        if (!deadSession.partyReviveCombatPauseStartedAt) {
            deadSession.partyReviveCombatPauseStartedAt = now;
        }
        return false;
    }
    if (deadSession.partyReviveCombatPauseStartedAt) {
        deadSession.partyReviveCombatPausedMs = Number(deadSession.partyReviveCombatPausedMs || 0) +
            Math.max(0, now - Number(deadSession.partyReviveCombatPauseStartedAt));
        deadSession.partyReviveCombatPauseStartedAt = undefined;
    }

    const members = partySessions(leaderSession);
    const living = members.filter(isAlive);
    if (living.length === 0) return true;
    if (living.length === 1 && living[0] === leaderSession && !playerCanResurrect(leaderSession)) return true;

    const waitedMs = now - Number(deadSession.deathTimerStart || now) -
        Number(deadSession.partyReviveCombatPausedMs || 0);
    return waitedMs >= PARTY_REVIVE_TIMEOUT_MS;
}

module.exports = {
    PARTY_REVIVE_TIMEOUT_MS,
    PARTY_DEATH_FRUSTRATION_WINDOW_MS,
    PARTY_DEATH_WARNING_COUNT,
    partySessions,
    deadMembers,
    partyCombatInProgress,
    learnedResurrectionSkills,
    resurrectionSkill,
    playerCanResurrect,
    tick,
    noteCompanionDeath,
    shouldTownRespawn
};
