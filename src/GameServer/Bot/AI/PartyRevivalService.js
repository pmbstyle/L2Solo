const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const SkillRankIndex = require('../../Skills/SkillRankIndex');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');

const PARTY_REVIVE_TIMEOUT_MS = 60000;
const PARTY_REVIVE_APPROACH_DISTANCE = 1500;
const APPROACH_STALL_MS = 5000;
const APPROACH_RETRY_MS = 15000;
const ATTEMPT_WAIT_GRACE_MS = 25000;
const REVIVE_ANIMATION_MS = 3000;
const failedApproaches = new WeakMap();

function position(actor) {
    return { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
}

function distance(a, b) {
    return Math.hypot(a.locX - b.locX, a.locY - b.locY, a.locZ - b.locZ);
}

function approachKey(provider, target) {
    return `${provider.actor.fetchId()}:${target.actor.fetchId()}`;
}

function recentlyFailed(leaderSession, provider, target, now) {
    const failures = failedApproaches.get(leaderSession);
    const key = approachKey(provider, target);
    const failure = failures?.get(key);
    if (!failure) return false;
    if (now >= failure.until || failure.provider !== provider.actor || failure.target !== target.actor
        || failure.deathStartedAt !== target.deathTimerStart
        || distance(position(provider.actor), failure.from) >= 64
        || distance(position(target.actor), failure.to) >= 64) {
        failures.delete(key);
        return false;
    }
    return true;
}

function noteFailedApproach(leaderSession, provider, target, now) {
    let failures = failedApproaches.get(leaderSession);
    if (!failures) failedApproaches.set(leaderSession, failures = new Map());
    for (const [key, failure] of failures) if (failure.until <= now) failures.delete(key);
    failures.set(approachKey(provider, target), {
        provider: provider.actor, target: target.actor,
        from: position(provider.actor), to: position(target.actor),
        deathStartedAt: target.deathTimerStart, until: now + APPROACH_RETRY_MS
    });
    // At most nine providers and nine corpses belong to one party.
    if (failures.size > 81) failures.delete(failures.keys().next().value);
}

function castingResurrection(provider, attempt) {
    if (!provider?.actor.state?.fetchCasts?.()) return false;
    const cast = provider.actor.attack?.activeCast;
    return !!cast && Number(cast.target?.fetchId?.()) === Number(attempt.targetId)
        && cast.skill?.fetchTargetKind?.() === 'corpse_player';
}

function noteCastStarted(session, actor, target) {
    const owner = session?.partyCompanion ? session.followPlayerSession
        : session?.hotBackgroundPartyId ? invoke('GameServer/Bot/AI/HotBackgroundParty').partyLeader(session) : null;
    const attempt = owner?.partyRevivalAttempt;
    if (attempt?.providerId !== actor.fetchId() || attempt.targetId !== target.fetchId()) return;
    // A fast native cast can begin and land between two AI ticks. Record
    // acceptance here so its stand-up animation is still protected then.
    attempt.casting = true;
    attempt.castFinishedAt = null;
}

function preserveCast(provider, attempt, now) {
    if (castingResurrection(provider, attempt)) {
        attempt.casting = true;
        attempt.castFinishedAt = null;
        return true;
    }
    if (!attempt.casting) return false;
    // doRevive keeps the corpse flag during its stand-up animation. A
    // completed native cast must not trigger a duplicate resurrection.
    attempt.castFinishedAt ??= now;
    return now - attempt.castFinishedAt < REVIVE_ANIMATION_MS;
}

function readyToCast(provider, target, skill) {
    const from = position(provider.actor), to = position(target.actor);
    if (Math.hypot(from.locX - to.locX, from.locY - to.locY) > Number(skill.fetchDistance?.() || 0)) return false;
    const geo = invoke('GameServer/Geodata/GeodataEngine');
    return geo.canWalkStraight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ)
        && geo.hasLineOfSight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ);
}

function withinReviveApproach(provider, target) {
    return Math.hypot(provider.fetchLocX() - target.fetchLocX(), provider.fetchLocY() - target.fetchLocY()) <= PARTY_REVIVE_APPROACH_DISTANCE
        && Math.abs(provider.fetchLocZ() - target.fetchLocZ()) <= 400;
}
const PARTY_DEATH_FRUSTRATION_WINDOW_MS = 10 * 60 * 1000;
const PARTY_DEATH_WARNING_COUNT = 2;
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
    return PartyAwareness.partySessions(leaderSession, { includeDead: true });
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

function combatResurrectionAllowed(leaderSession) {
    if (!leaderSession?.hotBackgroundPartyId) {
        const raid = leaderSession?.partyRaidEngagement;
        if (raid?.phase !== 'combat') return false;
        const tank = partySessions(leaderSession).find(s => Number(s.actor.fetchId()) === Number(raid.mainTankId));
        if (!isAlive(tank)) return false;
        const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
        return !partySessions(leaderSession).filter(isAlive).some(s => Threats.context(s).threats.length > 0);
    }
    if (leaderSession.partyCompanion) return false;
    const party = invoke('GameServer/Bot/Population/BackgroundPartyState').find(leaderSession.hotBackgroundPartyId);
    if (party?.status !== 'hot' || party.stats?.raidEncounter?.status === 'failed') return false;
    if (party.stats?.objective?.sourceKind !== 'raid' && party.stats?.objective?.raidBoss !== true) return false;
    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    return !partySessions(leaderSession).filter(isAlive).some(s => Threats.context(s).threats.length > 0);
}

function safeCombatProvider(session, leaderSession, skill) {
    const actor = session.actor;
    const role = invoke('GameServer/Bot/AI/BotRoles').inferRole(actor);
    if (role === 'tank' || actor.fetchHp() / Math.max(1, actor.fetchMaxHp()) < 0.65) return false;
    if (invoke('GameServer/Bot/AI/PartyAwareness').underDirectNpcAttack(session)) return false;
    const reserve = role === 'healer' ? 0.35 : 0.10;
    if ((actor.fetchMp() - Number(skill.fetchConsumedMp?.() || 0)) / Math.max(1, actor.fetchMaxMp()) < reserve) return false;
    // A healer is a fallback only while nobody needs their immediate care.
    return role !== 'healer' || !partySessions(leaderSession).filter(isAlive)
        .some(s => s.actor.fetchHp() / Math.max(1, s.actor.fetchMaxHp()) < 0.7);
}

function resurrectionScrollSkill() {
    const source = ItemTemplateIndex.findNumericRowRequired(DataCache.skills || [], RESURRECTION_SCROLL_SKILL_ID);
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
    const levelData = SkillRankIndex.find(source.levels ?? [], level) || {};
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
    if (castingResurrection(provider, attempt)) {
        preserveCast(provider, attempt, now);
        return;
    }
    if (!target) {
        // Also invalidate an old approach if somebody else revived its target.
        cancelAttempt(leaderSession);
        return;
    }
    if (preserveCast(provider, attempt, now)) return;
    if (!withinReviveApproach(provider.actor, target.actor)) {
        cancelAttempt(leaderSession);
        return;
    }
    const current = position(provider.actor);
    attempt.lastProgressAt ??= attempt.startedAt;
    attempt.position ??= current;
    if (distance(current, attempt.position) >= 32) {
        attempt.lastProgressAt = now;
        attempt.position = current;
    }
    const path = provider.lastPathfinding;
    const rejectedPath = path?.at >= attempt.startedAt && path.routeUsable === false
        && !provider.pendingPathRequest && !provider.actor.state?.inMotion?.();
    if (attempt.casting || rejectedPath || now - attempt.lastProgressAt >= APPROACH_STALL_MS) {
        noteFailedApproach(leaderSession, provider, target, now);
        cancelAttempt(leaderSession);
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
    }, { allowDeadTarget: true });
}

function cancelAttempt(leaderSession) {
    const attempt = leaderSession.partyRevivalAttempt;
    if (!attempt) return;
    const provider = partySessions(leaderSession).find(s => s.actor.fetchId() === attempt.providerId);
    if (provider?.actor) {
        const matchesAttempt = request => Number(request?.id) === Number(attempt.targetId)
            && Number(request?.selfId) === Number(attempt.skillId);
        // An unrelated native cast can own the action slot while our request
        // waits behind it. Drop only that queued/stored resurrection so it
        // cannot fire later after a different provider takes over.
        if (provider.actor.attack?.queue?.name === 'skill' && matchesAttempt(provider.actor.attack.queue.data)) {
            provider.actor.attack.resetQueuedEvent();
        }
        if (matchesAttempt(provider.actor.storedSpell)) provider.actor.storedSpell = undefined;
        if (provider.pendingPartyChatResult?.kind === 'resurrection'
            && Number(provider.pendingPartyChatResult.targetId) === Number(attempt.targetId)) {
            provider.pendingPartyChatResult = undefined;
        }
    }
    if (provider?.actor && !(provider.actor.state?.fetchCasts?.() && provider.actor.attack?.activeCast)) {
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(provider, provider.actor);
        if (provider.currentTargetId === attempt.targetId) {
            provider.currentTargetId = undefined;
            provider.actor.unselect?.();
        }
    }
    leaderSession.partyRevivalAttempt = null;
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
    const activeAttempt = leaderSession.partyRevivalAttempt;
    if (activeAttempt && preserveCast(partySessions(leaderSession)
        .find(s => s.actor.fetchId() === activeAttempt.providerId), activeAttempt, now)) {
        return { handled: activeAttempt.providerId === session.actor.fetchId(), waiting: true, targetId: activeAttempt.targetId };
    }
    if (dead.length === 0) {
        failedApproaches.delete(leaderSession);
        return { handled: false, dead };
    }
    const combat = background
        ? { active: partyCombatInProgress(leaderSession), reason: 'party_combat' }
        : PartyCombatState.combatState(leaderSession);
    const combatRescue = combatResurrectionAllowed(leaderSession);
    if (combat.active && !combatRescue) {
        cancelAttempt(leaderSession);
        return { handled: false, dead, blockedBy: combat.reason, threat: combat.target };
    }
    // Death classification owns the raid outcome. Never race its async
    // failure transaction by resurrecting a critical role mid-wipe.
    const rescueTargets = combat.active && background ? dead.filter(s => s.hotRaidCasualtyAt) : dead;

    const attempt = leaderSession.partyRevivalAttempt;
    if (attempt) {
        const provider = partySessions(leaderSession).find(s => s.actor.fetchId() === attempt.providerId);
        if (combat.active && provider && !safeCombatProvider(provider, leaderSession,
            resurrectionSkill(provider.actor) || resurrectionScrollSkill())) {
            cancelAttempt(leaderSession);
        } else {
            // A geodata detour ends without invoking the original action.
            // Retry from the reached position instead of holding an idle lease.
            if (provider === session && !provider.actor.state?.inMotion?.() && !provider.pendingPathRequest
                && !provider.actor.state?.fetchCasts?.() && !provider.actor.isBlocked?.()
                && provider.lastPathfinding?.at >= attempt.startedAt && provider.lastPathfinding.routeUsable === true
                && now - Number(attempt.lastRequestedAt || attempt.startedAt) >= 1000) {
                const target = dead.find(s => s.actor.fetchId() === attempt.targetId);
                const skill = target && (attempt.source === 'skill'
                    ? resurrectionSkill(provider.actor) : resurrectionScrollSkill());
                if (skill) requestResurrection(provider, target.actor, skill, attempt, Generics, now);
            }
            return { handled: attempt.providerId === session.actor.fetchId(), waiting: true, targetId: attempt.targetId };
        }
    }

    // The leader is the party's anchor.  Restore them first even if another
    // companion happens to have a lower character id.
    const availableProviders = partySessions(leaderSession)
        .filter(isAlive)
        .filter(s => background || s !== leaderSession)
        .filter(s => !invoke('GameServer/Bot/AI/ClanAllianceSupportAI').leaderFor(s))
        // Background parties use learned resurrection. Do not inherit the
        // player-companion fallback that manufactures a scroll cast.
        .filter(s => !background || learnedResurrectionSkills(s.actor).length > 0);
    const raidBoss = leaderSession.partyRaidEngagement && invoke('GameServer/Bot/AI/BotRaidSafety')
        .raidBossByObjectId(leaderSession.partyRaidEngagement.bossId);
    const eligibleProviders = availableProviders.filter(s => !raidBoss
        || !invoke('GameServer/RaidBoss/RaidCurse').isAboveRaidThreshold(s.actor, raidBoss));
    const targetSession = rescueTargets.filter(target => eligibleProviders.some(provider => withinReviveApproach(provider.actor, target.actor)
        && !recentlyFailed(leaderSession, provider, target, now))).sort((a, b) => (
        Number(b === leaderSession) - Number(a === leaderSession) ||
        Number(a.actor.fetchId()) - Number(b.actor.fetchId())
    ))[0];
    if (!targetSession) return { handled: false, dead };
    const providers = eligibleProviders
        .filter((memberSession) => withinReviveApproach(memberSession.actor, targetSession.actor))
        .filter(s => !recentlyFailed(leaderSession, s, targetSession, now))
        .filter((memberSession) => !memberSession.actor.state?.fetchCasts?.())
        .filter(s => invoke('GameServer/Effects/EffectRestrictions').canCast(s.actor))
        .filter(s => !combat.active || safeCombatProvider(s, leaderSession,
            resurrectionSkill(s.actor) || resurrectionScrollSkill()));
    const skilled = providers
        .map((providerSession) => ({ session: providerSession, skill: resurrectionSkill(providerSession.actor) }))
        .filter((entry) => entry.skill)
        .filter(entry => !combat.active || safeCombatProvider(entry.session, leaderSession, entry.skill))
        .map(entry => ({ ...entry, ready: readyToCast(entry.session, targetSession, entry.skill) }))
        .sort((a, b) => {
            const Roles = invoke('GameServer/Bot/AI/BotRoles');
            return Number(b.ready) - Number(a.ready)
                || Number(Roles.inferRole(a.session.actor) === 'healer') - Number(Roles.inferRole(b.session.actor) === 'healer')
                || distance(position(a.session.actor), position(targetSession.actor)) - distance(position(b.session.actor), position(targetSession.actor))
                || Number(a.session.actor.fetchId()) - Number(b.session.actor.fetchId());
        })[0] || null;
    const provider = skilled?.session || providers.sort((a, b) => Number(a.actor.fetchId()) - Number(b.actor.fetchId()))[0] || null;
    if (!provider || provider !== session) return { handled: false, dead };
    if (background && !skilled) return { handled: false, dead };

    const skill = skilled?.skill || resurrectionScrollSkill();
    if (!skill) return { handled: false, dead };

    if (background || combat.active) {
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, session.actor);
        if (session.actor.state.fetchSeated?.()) {
            session.actor.state.setSeated(false);
            session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(session.actor), session.actor);
        }
    }
    const newAttempt = leaderSession.partyRevivalAttempt = {
        providerId: session.actor.fetchId(),
        targetId: targetSession.actor.fetchId(),
        source: skilled ? 'skill' : 'scroll',
        startedAt: now,
        lastProgressAt: now,
        position: position(session.actor)
    };

    requestResurrection(session, targetSession.actor, skill, newAttempt, Generics, now);

    return {
        handled: true,
        target: targetSession.actor,
        source: newAttempt.source
    };
}

function requestResurrection(session, target, skill, attempt, Generics, now) {
    attempt.lastRequestedAt = now;
    attempt.skillId = skill.fetchSelfId();
    if (attempt.source === 'skill') {
        session.currentTargetId = target.fetchId();
        session.actor.select?.({ id: target.fetchId() });
        invoke('GameServer/Bot/AI/BotPartyChat').expectSkillResult(session, {
            target,
            skill,
            kind: 'resurrection'
        });
        Generics.skillExec(session, session.actor, {
            id: target.fetchId(),
            selfId: skill.fetchSelfId(),
            ctrl: false
        });
    } else {
        castScroll(session, session.actor, target, skill);
    }
}

function shouldTownRespawn(leaderSession, deadSession, now = Date.now()) {
    if (!isRescueMember(deadSession, leaderSession) || !leaderSession?.actor?.fetchIsOnline?.()) return true;
    const attempt = leaderSession.partyRevivalAttempt;
    const members = partySessions(leaderSession);
    if (attempt?.targetId === deadSession.actor.fetchId()) {
        const provider = members.find(s => s.actor.fetchId() === attempt.providerId);
        if (isAlive(provider) && preserveCast(provider, attempt, now)) return false;
    }
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
    if (partyCombatInProgress(leaderSession) && !combatResurrectionAllowed(leaderSession)) {
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

    const living = members.filter(isAlive);
    if (living.length === 0) return true;
    if (!background && living.length === 1 && living[0] === leaderSession && !playerCanResurrect(leaderSession)) return true;

    // A cast accepted before the deadline must be allowed to land, including
    // the native stand-up animation. Failed attempts remain time-bounded.
    if (attempt?.targetId === deadSession.actor.fetchId()
        && now - Number(attempt.startedAt || 0) < ATTEMPT_WAIT_GRACE_MS
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
    combatResurrectionAllowed,
    learnedResurrectionSkills,
    resurrectionSkill,
    noteCastStarted,
    playerCanResurrect,
    tick,
    noteCompanionDeath,
    shouldTownRespawn
};
