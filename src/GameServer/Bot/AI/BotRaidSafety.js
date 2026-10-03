const RAID_MINION_TEMPLATE_IDS = new Set(
    require('../../../../data/Npcs/Minions/c4_raid_bosses.json')
        .map((entry) => Number(entry.minionId))
        .filter((id) => Number.isInteger(id) && id > 0)
);
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');

const DEFAULT_RETREAT_DISTANCE = 1100;
const RAID_DISENGAGE_GRACE_MS = 15000;
const RAID_OPENER_MIN_HP_RATIO = 0.55;
const RAID_PULL_RADIUS = 900;

function world() {
    return invoke('GameServer/World/World');
}

function objectId(actor) {
    const id = Number(actor?.fetchId?.() || 0);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function templateId(target) {
    const value = target?.fetchSelfId?.()
        ?? target?.fetchTemplateId?.()
        ?? target?.selfId
        ?? target?.model?.selfId;
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function isRaidBoss(target) {
    return target?.fetchIsRaidBoss?.() === true
        || target?.model?.raidBoss === true
        || target?.template?.raidBoss === true
        || String(target?.fetchKind?.() || '').toLowerCase() === 'boss'
        || String(target?.template?.kind || '').toLowerCase() === 'boss'
        || String(target?.model?.template?.kind || '').toLowerCase() === 'boss';
}

function isRaidMinion(target) {
    return Number(target?.minionBossObjectId || 0) > 0
        || Number(target?.minionBossTemplateId || 0) > 0
        || RAID_MINION_TEMPLATE_IDS.has(templateId(target));
}

function isProtectedRaidEntity(target) {
    return isRaidBoss(target) || isRaidMinion(target);
}

function botClanRaidObjective(session) {
    if (!session?.hotBackgroundPartyId || session.partyCompanion === true) return null;
    const party = invoke('GameServer/Bot/Population/BackgroundPartyState')
        .find(session.hotBackgroundPartyId);
    const objective = party?.stats?.objective;
    return party?.status === 'hot' && party?.stats?.raidEncounter?.status !== 'failed'
        && objective?.sourceKind === 'raid'
        && Number(objective.raidBossTemplateId || objective.npcId) > 0
        ? objective : null;
}

function canEngageBotClanRaid(session, target) {
    const objective = botClanRaidObjective(session);
    if (!objective || !isProtectedRaidEntity(target)) return false;
    const boss = raidBossFor(target);
    return Number(templateId(boss)) === Number(objective.raidBossTemplateId || objective.npcId);
}

function raidBossFor(target) {
    if (!target) return null;
    if (isRaidBoss(target)) return target;
    return RaidEntityIndex.bossFor(world(), target);
}

function raidBossByObjectId(id) {
    return RaidEntityIndex.bossByObjectId(world(), id);
}

function raidEntityByObjectId(id) {
    return RaidEntityIndex.raidEntityByObjectId(world(), id);
}

function belongsToRaid(target, raid) {
    if (!target || !raid || !isProtectedRaidEntity(target)) return false;
    const boss = raidBossFor(target);
    return !!boss && (
        objectId(boss) === Number(raid.bossId || 0)
    );
}

function isOnlineCompanion(session, leaderSession) {
    return !!session?.actor && session.partyCompanion === true &&
        session.followPlayerSession === leaderSession &&
        session.actor.fetchIsOnline?.() === true &&
        !session.actor.isDead?.() && !session.actor.state?.fetchDead?.();
}

function playerPartySessions(leaderSession) {
    if (!leaderSession || leaderSession.partyCompanion === true || String(leaderSession.accountId || '').startsWith('bot_')) {
        return [];
    }
    return [...new Set([leaderSession, ...(world().user?.sessions || []),
        ...(invoke('GameServer/Bot/BotManager').sessions || [])])].filter((session) => (
        session === leaderSession || isOnlineCompanion(session, leaderSession)
    ));
}

function hasHeavyArmor(actor) {
    return (actor?.backpack?.fetchEquippedArmors?.() || [])
        .some((item) => item?.fetchKind?.() === 'Armor.Chain');
}

function isRaidOpenerReady(actor) {
    const hp = Number(actor?.fetchHp?.() || 0);
    const maxHp = Math.max(1, Number(actor?.fetchMaxHp?.() || hp || 1));
    return hp / maxHp >= RAID_OPENER_MIN_HP_RATIO;
}

function raidOpenerScore(session) {
    const actor = session.actor;
    const role = invoke('GameServer/Bot/AI/BotRoles').inferRole(actor);
    const hp = Number(actor.fetchHp?.() || 0);
    const maxHp = Math.max(1, Number(actor.fetchMaxHp?.() || hp || 1));
    return [
        role === 'tank' ? 1 : 0,
        hasHeavyArmor(actor) ? 1 : 0,
        isRaidOpenerReady(actor) ? 1 : 0,
        Number(actor.fetchPDef?.() || 0),
        hp / maxHp,
        -Number(actor.fetchId?.() || 0)
    ];
}

function compareScores(a, b) {
    const aScore = raidOpenerScore(a);
    const bScore = raidOpenerScore(b);
    for (let index = 0; index < aScore.length; index++) {
        if (aScore[index] !== bScore[index]) return bScore[index] - aScore[index];
    }
    return 0;
}

function selectRaidOpener(leaderSession, boss = null) {
    return playerPartySessions(leaderSession)
        .filter((session) => session !== leaderSession && isOnlineCompanion(session, leaderSession))
        .filter(session => !boss || !invoke('GameServer/RaidBoss/RaidCurse').isAboveRaidThreshold(session.actor, boss))
        .sort(compareScores)[0] || null;
}

function leaderDesignatedRaidTarget(leaderSession) {
    const leader = leaderSession?.actor;
    if (!leader || leader.fetchIsOnline?.() !== true || leader.isDead?.() || leader.state?.fetchDead?.()) return null;
    const targetId = Number(leader.fetchDestId?.() || 0);
    if (!targetId) return null;
    const target = RaidEntityIndex.raidEntityByObjectId(world(), targetId);
    if (!target || target.fetchAttackable?.() !== true || target.isDead?.()) return null;

    const boss = raidBossFor(target);
    return boss && boss.fetchAttackable?.() === true && !boss.isDead?.()
        ? { target, boss }
        : null;
}

function leaderDesignatedRaidBoss(leaderSession) {
    return leaderDesignatedRaidTarget(leaderSession)?.boss || null;
}

function raidEntities(raid) {
    return RaidEntityIndex.entitiesForRaid(world(), raid);
}

function currentCombatTargetId(actor) {
    const actionTargetId = actor?.automation?.fetchDestId?.();
    if (actionTargetId !== undefined && actionTargetId !== null) return Number(actionTargetId);
    if (actor?.state?.fetchCombats?.() !== true) return null;
    const selectedTargetId = actor?.fetchDestId?.();
    return selectedTargetId === undefined || selectedTargetId === null
        ? null
        : Number(selectedTargetId);
}

function raidHasPartyCombat(leaderSession, raid) {
    const sessions = playerPartySessions(leaderSession).filter(session => session.actor.fetchIsOnline?.() === true
        && !session.actor.isDead?.() && !session.actor.state?.fetchDead?.());
    const memberIds = new Set(sessions.map((session) => objectId(session.actor)).filter(Boolean));
    if (memberIds.size === 0) return false;

    const entities = raidEntities(raid);
    if (entities.some((npc) => memberIds.has(Number(npc.fetchDestId?.() || 0)))) return true;
    const entityIds = new Set(entities.map(objectId).filter(Boolean));
    return sessions.some((session) => (session === leaderSession || session.actor.state?.fetchHits?.()
        || session.actor.state?.fetchCasts?.() || session.actor.state?.fetchCombats?.())
        && entityIds.has(currentCombatTargetId(session.actor)));
}

function startPlayerPartyRaid(leaderSession, boss, target, now) {
    const opener = selectRaidOpener(leaderSession, boss);
    const mainTank = invoke('GameServer/Bot/AI/BotRoles').inferRole(leaderSession.actor) === 'tank'
        ? leaderSession : opener;
    leaderSession.backgroundRaidTactics = undefined;
    leaderSession.backgroundRaidActionClaims = undefined;
    leaderSession.raidOpenedBossId = undefined;
    const raid = {
        bossId: objectId(boss),
        bossTemplateId: templateId(boss),
        targetId: objectId(target || boss),
        targetTemplateId: templateId(target || boss),
        openerId: objectId(opener?.actor),
        mainTankId: objectId(mainTank?.actor),
        pullOrigin: { locX: leaderSession.actor.fetchLocX(), locY: leaderSession.actor.fetchLocY(),
            locZ: leaderSession.actor.fetchLocZ() },
        phase: 'opening',
        selectedAt: now,
        lastActiveAt: now
    };
    leaderSession.partyRaidEngagement = raid;
    return raid;
}

function canStartPlayerRaidPull(leaderSession, boss) {
    if (leaderSession.partyCompanionSettings?.pullMode === 'off') return false;
    if (leaderSession.partyRaidPullBlockedBossId === objectId(boss)) return false;
    if (leaderSession.partyPullState?.targetId && leaderSession.partyPullState?.type !== 'raid') return false;
    const origin = leaderSession.actor;
    if (Math.hypot(origin.fetchLocX() - boss.fetchLocX(), origin.fetchLocY() - boss.fetchLocY()) > RAID_PULL_RADIUS
        || Math.abs(origin.fetchLocZ() - boss.fetchLocZ()) > 400) return false;
    return invoke('GameServer/Bot/AI/BotHuntingVisibility').canSee(origin, boss);
}

function cancelPlayerRaidOpening(leaderSession, raid) {
    const ids = new Set(raidEntities(raid).map(objectId));
    for (const member of playerPartySessions(leaderSession)) {
        if (member === leaderSession || !ids.has(Number(member.currentTargetId || currentCombatTargetId(member.actor)))) continue;
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(member, member.actor);
        invoke('GameServer/Bot/AI/BotPvpTactics').followSummon(member, member.actor);
        member.currentTargetId = undefined;
        member.actor.unselect?.();
    }
    leaderSession.partyRaidEngagement = undefined;
    if (leaderSession.partyPullState?.type === 'raid') leaderSession.partyPullState = {};
}

function endPlayerPartyRaid(leaderSession) {
    if (!leaderSession?.partyRaidEngagement && leaderSession?.partyPullState?.type !== 'raid') return false;
    const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
    const AI = invoke('GameServer/Bot/BotAI');
    // Include fallen companions: a town teleport revives them, and their old
    // retreat/support orders must not survive that native recovery.
    const companions = invoke('GameServer/Bot/AI/PartyCompanionService').membersForLeader(leaderSession);
    Tactics.stop(leaderSession, leaderSession.actor);
    leaderSession.currentTargetId = undefined;
    leaderSession.actor.unselect?.();
    for (const member of companions) {
        AI.cancelScheduledTick(member);
        Tactics.stop(member, member.actor);
        Tactics.followSummon(member, member.actor);
        for (const key of ['currentTargetId', 'incomingThreatId', 'incomingThreatAt', 'fleeStart',
            'fleeDestination', 'raidSafetyResumePlan', 'playerRaidRetreatAt', 'pendingSupportApproach',
            'pendingPartyChatResult', 'lastFollowMoveTarget', 'playerRaidResurrectionRecovery']) delete member[key];
        member.actor.unselect?.();
        member.plan = 'following';
    }
    for (const key of ['partyRaidEngagement', 'partyRaidPullBlockedBossId', 'partyRevivalAttempt',
        'backgroundRaidTactics', 'backgroundRaidActionClaims', 'raidOpenedBossId', 'playerRaidChatter',
        'playerRaidChatterCheckAt', 'pvpHealClaims', 'pvpControlClaims']) delete leaderSession[key];
    if (leaderSession.partyPullState?.type === 'raid') leaderSession.partyPullState = {};
    return true;
}

function syncPlayerPartyRaid(leaderSession, now = Date.now()) {
    if (leaderSession?.pendingActorTeleport) return null;
    if (playerPartySessions(leaderSession).length === 0) {
        if (leaderSession) leaderSession.partyRaidEngagement = undefined;
        return null;
    }

    const selectedRaidTarget = leaderDesignatedRaidTarget(leaderSession);
    const selectedBoss = selectedRaidTarget?.boss || null;
    const selectedTarget = selectedRaidTarget?.target || null;
    let raid = leaderSession.partyRaidEngagement;
    if (objectId(selectedBoss) !== leaderSession.partyRaidPullBlockedBossId) leaderSession.partyRaidPullBlockedBossId = undefined;
    const existingBoss = raid
        ? RaidEntityIndex.bossByObjectId(world(), raid.bossId)
        : null;
    if (raid && (!existingBoss || existingBoss.isDead?.() || leaderSession.actor.fetchIsOnline?.() !== true)) {
        leaderSession.partyRaidEngagement = undefined;
        raid = null;
    }

    if (selectedBoss) {
        const selectedRaid = {
            bossId: objectId(selectedBoss),
            bossTemplateId: templateId(selectedBoss)
        };
        const selectedMatches = Number(selectedRaid.bossId) === Number(raid?.bossId || 0);
        // Reconcile an opening target atomically. During combat, change raids
        // only when live party targeting/aggro proves that the newly selected
        // entity is the fight in progress; a stray click must not abandon the
        // current raid's grace period.
        if ((!raid || (!selectedMatches && (
            raid.phase === 'opening' || raidHasPartyCombat(leaderSession, selectedRaid)
        ))) && (raidHasPartyCombat(leaderSession, selectedRaid) || canStartPlayerRaidPull(leaderSession, selectedBoss))) {
            raid = startPlayerPartyRaid(leaderSession, selectedBoss, selectedTarget, now);
        }
    }

    if (!raid) return null;
    if (selectedTarget && belongsToRaid(selectedTarget, raid)) {
        raid.targetId = objectId(selectedTarget);
        raid.targetTemplateId = templateId(selectedTarget);
    }
    const selectedMatches = selectedBoss && objectId(selectedBoss) === Number(raid.bossId || 0);
    const activeCombat = raidHasPartyCombat(leaderSession, raid);
    if (raid.phase === 'opening') {
        if (!activeCombat && (!selectedMatches || leaderSession.partyCompanionSettings?.pullMode === 'off')) {
            cancelPlayerRaidOpening(leaderSession, raid);
            return null;
        }
        const openerStillAvailable = playerPartySessions(leaderSession)
            .some((session) => objectId(session.actor) === Number(raid.openerId || 0) && isOnlineCompanion(session, leaderSession));
        if (!openerStillAvailable && !activeCombat) {
            const replacement = selectRaidOpener(leaderSession, existingBoss || selectedBoss);
            if (Number(raid.mainTankId) === Number(raid.openerId)) raid.mainTankId = objectId(replacement?.actor);
            raid.openerId = objectId(replacement?.actor);
        }
    }

    if (raid.phase === 'retreat') return raid;
    if (!raid.mainTankId) raid.mainTankId = invoke('GameServer/Bot/AI/BotRoles').inferRole(leaderSession.actor) === 'tank'
        ? objectId(leaderSession.actor) : raid.openerId;
    if (activeCombat) {
        raid.phase = 'combat';
        raid.lastActiveAt = now;
    } else if (selectedMatches && raid.phase === 'opening') {
        raid.lastActiveAt = now;
    } else if (raid.phase === 'combat' && now - Number(raid.lastActiveAt || 0) > RAID_DISENGAGE_GRACE_MS) {
        leaderSession.partyRaidEngagement = undefined;
        return null;
    }

    return raid;
}

function canEngagePlayerPartyRaid(session, target, leaderSession = session?.followPlayerSession) {
    if (!isOnlineCompanion(session, leaderSession)) return false;
    const raid = syncPlayerPartyRaid(leaderSession);
    if (!raid || !belongsToRaid(target, raid)) return false;
    if (raid.phase === 'combat') return true;
    return raid.phase === 'opening' &&
        objectId(session.actor) === Number(raid.mainTankId || raid.openerId || 0) &&
        objectId(target) === Number(raid.bossId || 0);
}

function isEngagedPlayerPartyRaidTarget(leaderSession, target) {
    const raid = syncPlayerPartyRaid(leaderSession);
    return raid?.phase === 'combat' && belongsToRaid(target, raid);
}

function hasControlledRaidMinion(target) {
    const boss = raidBossFor(target);
    if (!boss) return false;
    const raid = { bossId: objectId(boss), bossTemplateId: templateId(boss) };
    const EffectStore = invoke('GameServer/Effects/EffectStore');
    const minions = raidEntities(raid).filter(npc => isRaidMinion(npc) && !npc.isDead?.());
    return minions.length > 1 && minions.some((npc) => {
        const impairments = EffectStore.impairments(npc);
        return impairments.disabled;
    });
}

function botClanRaidCombatPlan(ownerSession, target) {
    const boss = raidBossFor(target);
    if (!boss || boss.isDead?.()) {
        if (ownerSession) ownerSession.backgroundRaidTactics = undefined;
        return null;
    }
    const raid = { bossId: objectId(boss), bossTemplateId: templateId(boss) };
    const EffectStore = invoke('GameServer/Effects/EffectStore');
    const minions = raidEntities(raid)
        .filter((npc) => isRaidMinion(npc) && !npc.isDead?.())
        .sort((left, right) => Number(objectId(left) || 0) - Number(objectId(right) || 0));
    let state = ownerSession?.backgroundRaidTactics;
    if (!state || Number(state.bossId || 0) !== Number(raid.bossId || 0)) {
        state = { bossId: raid.bossId, focusMinionId: null };
    }
    const hardControlled = (npc) => EffectStore.impairments(npc).disabled === true;
    let focusMinion = minions.find((npc) => (
        Number(objectId(npc)) === Number(state.focusMinionId || 0) && !hardControlled(npc)
    ));
    if (!focusMinion) focusMinion = minions.find((npc) => !hardControlled(npc))
        || (minions.length === 1 ? minions[0] : null);
    state.focusMinionId = objectId(focusMinion);
    if (ownerSession) ownerSession.backgroundRaidTactics = state;
    return {
        boss,
        minions,
        focusMinion,
        controlTargets: minions.filter((npc) => npc !== focusMinion),
        raid
    };
}

function clearTarget(session, bot, target) {
    const targetId = Number(target?.fetchId?.() || 0);
    if (!targetId || Number(session?.currentTargetId || 0) === targetId) {
        if (session) session.currentTargetId = undefined;
        bot?.unselect?.();
    }
}

function retreat(session, bot, threat, options = {}) {
    if (!session || !bot || !isProtectedRaidEntity(threat)) return false;
    // The generic hunting/resting safety net also sees recent raid hits.  An
    // autonomous clan member must not reinterpret its own authorized boss or
    // minion as an accidental raid pull and run away a tick after the main
    // tank opens.  Failed raids no longer pass canEngageBotClanRaid, so their
    // coordinated retreat still uses this function normally.
    if (canEngageBotClanRaid(session, threat)) return false;

    const wasSeated = bot.state?.fetchSeated?.() === true;
    clearTarget(session, bot, threat);
    bot.attack?.abortCast?.(session, bot);
    bot.attack?.clearTimers?.();
    bot.state?.setHits?.(false);
    bot.state?.setCasts?.(false);
    bot.automation?.abortAll?.(bot);
    invoke('GameServer/Bot/AI/BotPvpTactics').followSummon(session, bot);

    if (wasSeated) {
        bot.state?.setSeated?.(false);
        try {
            const ServerResponse = invoke('GameServer/Network/Response');
            session.dataSendToOthers?.(ServerResponse.sitAndStand(bot), bot);
        } catch (_) {}
    }

    if (session.plan !== 'fleeing') {
        session.raidSafetyResumePlan = session.partyCompanion === true && session.followPlayerSession
            ? 'following'
            : (session.plan === 'resting' ? 'resting' : 'hunting');
    }
    session.plan = 'fleeing';
    session.fleeStart = Date.now();
    session.incomingThreatId = undefined;
    session.incomingThreatAt = undefined;
    session.lastDecision = {
        action: 'retreat',
        reason: 'raid_entity_protected',
        targetId: Number(threat.fetchId?.() || 0) || null,
        targetName: threat.fetchName?.() || null,
        at: Date.now()
    };

    const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
    BotRetreatPlanner.retreat(session, bot, threat, {
        distance: Math.max(100, Number(options.distance || DEFAULT_RETREAT_DISTANCE))
    });
    return true;
}

module.exports = {
    RAID_PULL_RADIUS,
    RAID_MINION_TEMPLATE_IDS,
    isRaidBoss,
    isRaidMinion,
    isProtectedRaidEntity,
    botClanRaidObjective,
    canEngageBotClanRaid,
    raidBossFor,
    raidBossByObjectId,
    raidEntityByObjectId,
    raidEntities,
    belongsToRaid,
    playerPartySessions,
    raidHasPartyCombat,
    hasHeavyArmor,
    isRaidOpenerReady,
    selectRaidOpener,
    leaderDesignatedRaidBoss,
    leaderDesignatedRaidTarget,
    syncPlayerPartyRaid,
    endPlayerPartyRaid,
    canEngagePlayerPartyRaid,
    isEngagedPlayerPartyRaidTarget,
    hasControlledRaidMinion,
    botClanRaidCombatPlan,
    clearTarget,
    retreat
};
