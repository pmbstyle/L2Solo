const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');

const PARTY_REVIVE_TIMEOUT_MS = 60000;
const PARTY_REVIVE_APPROACH_DISTANCE = 1500;

function withinReviveApproach(provider, target) {
    return Math.hypot(provider.fetchLocX() - target.fetchLocX(), provider.fetchLocY() - target.fetchLocY()) <= PARTY_REVIVE_APPROACH_DISTANCE
        && Math.abs(provider.fetchLocZ() - target.fetchLocZ()) <= 400;
}
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
    if (leaderSession.hotBackgroundPartyId && !leaderSession.partyCompanion) {
        return invoke('GameServer/Bot/AI/HotBackgroundParty').roster(leaderSession);
    }
    const BotManager = invoke('GameServer/Bot/BotManager');
    return [leaderSession, ...(BotManager.sessions || []).filter((session) => isCompanionOf(session, leaderSession))];
}

function isRescueMember(session, leaderSession) {
    return leaderSession?.hotBackgroundPartyId && !leaderSession.partyCompanion
        ? partySessions(leaderSession).includes(session)
        : isCompanionOf(session, leaderSession);
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
    if (leaderSession?.hotBackgroundPartyId && !leaderSession.partyCompanion) {
        const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
        const living = partySessions(leaderSession).filter(isAlive);
        if (living.some(s => Threats.context(s).threats.length > 0)) return true;
        // An autonomous leader's stale selection is not an order to pull
        // another monster while a party member needs resurrection.
        return PartyCombatState.isActive(leaderSession, { ignoreLeaderSelection: true });
    }
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
    if (!attempt) return;
    const provider = partySessions(leaderSession).find(s => s.actor.fetchId() === attempt.providerId);
    const target = dead.find(s => s.actor.fetchId() === attempt.targetId);
    if (!isAlive(provider)) {
        leaderSession.partyRevivalAttempt = null;
        return;
    }
    if (target && provider && !withinReviveApproach(provider.actor, target.actor)) {
        if (provider.currentTargetId === attempt.targetId) {
            provider.actor.automation?.abortAll?.(provider.actor);
            provider.currentTargetId = undefined;
            provider.actor.unselect?.();
            provider.pendingPartyChatResult = undefined;
        }
        leaderSession.partyRevivalAttempt = null;
        return;
    }
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
    if (!isRescueMember(session, leaderSession) || !isAlive(session)) return { handled: false };
    const background = !!leaderSession.hotBackgroundPartyId && !leaderSession.partyCompanion;

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
    const combat = background
        ? { active: partyCombatInProgress(leaderSession), reason: 'party_combat' }
        : PartyCombatState.combatState(leaderSession);
    if (combat.active) return { handled: false, dead, blockedBy: combat.reason, threat: combat.target };

    const attempt = leaderSession.partyRevivalAttempt;
    if (attempt) return { handled: attempt.providerId === session.actor.fetchId(), waiting: true, targetId: attempt.targetId };

    // The leader is the party's anchor.  Restore them first even if another
    // companion happens to have a lower character id.
    const availableProviders = partySessions(leaderSession)
        .filter(isAlive)
        .filter(s => background || s !== leaderSession)
        .filter(s => !invoke('GameServer/Bot/AI/ClanAllianceSupportAI').leaderFor(s))
        // Background parties use learned resurrection. Do not inherit the
        // player-companion fallback that manufactures a scroll cast.
        .filter(s => !background || learnedResurrectionSkills(s.actor).length > 0);
    const targetSession = dead.filter(target => availableProviders.some(provider => withinReviveApproach(provider.actor, target.actor))).sort((a, b) => (
        Number(b === leaderSession) - Number(a === leaderSession) ||
        Number(a.actor.fetchId()) - Number(b.actor.fetchId())
    ))[0];
    if (!targetSession) return { handled: false, dead };
    const providers = availableProviders
        .filter((memberSession) => withinReviveApproach(memberSession.actor, targetSession.actor))
        .filter((memberSession) => !memberSession.actor.state?.fetchCasts?.())
        .filter(s => !background || invoke('GameServer/Effects/EffectRestrictions').canCast(s.actor));
    const skilled = providers
        .map((providerSession) => ({ session: providerSession, skill: resurrectionSkill(providerSession.actor) }))
        .filter((entry) => entry.skill)
        .sort((a, b) => Number(a.session.actor.fetchId()) - Number(b.session.actor.fetchId()))[0] || null;
    const provider = skilled?.session || providers.sort((a, b) => Number(a.actor.fetchId()) - Number(b.actor.fetchId()))[0] || null;
    if (!provider || provider !== session) return { handled: false, dead };
    if (background && !skilled) return { handled: false, dead };

    const skill = skilled?.skill || resurrectionScrollSkill();
    if (!skill) return { handled: false, dead };

    if (background) {
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, session.actor);
        if (session.actor.state.fetchSeated?.()) {
            session.actor.state.setSeated(false);
            session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(session.actor), session.actor);
        }
    }
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
    if (!isRescueMember(deadSession, leaderSession) || !leaderSession?.actor?.fetchIsOnline?.()) return true;
    // A remote courier cannot be rescued by this group. A fight elsewhere
    // must not pause its town recovery or send support across the map.
    if (!partySessions(leaderSession).some(s => isAlive(s) && withinReviveApproach(s.actor, deadSession.actor))) return true;
    const background = !!leaderSession.hotBackgroundPartyId && !leaderSession.partyCompanion;
    if (background && !partySessions(leaderSession).some(s => isAlive(s)
        && withinReviveApproach(s.actor, deadSession.actor) && learnedResurrectionSkills(s.actor).length > 0)) return true;

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
    if (!background && living.length === 1 && living[0] === leaderSession && !playerCanResurrect(leaderSession)) return true;

    // A cast accepted before the deadline must be allowed to land, including
    // the native stand-up animation. Failed attempts remain time-bounded.
    const attempt = leaderSession.partyRevivalAttempt;
    if (background && attempt?.targetId === deadSession.actor.fetchId()
        && now - Number(attempt.startedAt || 0) < 25000
        && living.some(s => s.actor.fetchId() === attempt.providerId
            && withinReviveApproach(s.actor, deadSession.actor))) return false;

    const waitedMs = now - Number(deadSession.deathTimerStart || now) -
        Number(deadSession.partyReviveCombatPausedMs || 0);
    return waitedMs >= PARTY_REVIVE_TIMEOUT_MS;
}

module.exports = {
    PARTY_REVIVE_APPROACH_DISTANCE,
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
