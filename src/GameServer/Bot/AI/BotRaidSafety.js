const RAID_MINION_TEMPLATE_IDS = new Set(
    require('../../../../data/Npcs/Minions/c4_raid_bosses.json')
        .map((entry) => Number(entry.minionId))
        .filter((id) => Number.isInteger(id) && id > 0)
);
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');

const DEFAULT_RETREAT_DISTANCE = 1100;
const RAID_DISENGAGE_GRACE_MS = 15000;
const RAID_OPENER_MIN_HP_RATIO = 0.55;

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
        || target?.template?.raidBoss === true;
}

function isRaidMinion(target) {
    return Number(target?.minionBossObjectId || 0) > 0
        || Number(target?.minionBossTemplateId || 0) > 0
        || RAID_MINION_TEMPLATE_IDS.has(templateId(target));
}

function isProtectedRaidEntity(target) {
    return isRaidBoss(target) || isRaidMinion(target);
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
        objectId(boss) === Number(raid.bossId || 0) ||
        templateId(boss) === Number(raid.bossTemplateId || 0)
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
    return (world().user?.sessions || []).filter((session) => (
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

function selectRaidOpener(leaderSession) {
    return playerPartySessions(leaderSession)
        .filter((session) => session !== leaderSession && isOnlineCompanion(session, leaderSession))
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
    const sessions = playerPartySessions(leaderSession);
    const memberIds = new Set(sessions.map((session) => objectId(session.actor)).filter(Boolean));
    if (memberIds.size === 0) return false;

    const entities = raidEntities(raid);
    if (entities.some((npc) => memberIds.has(Number(npc.fetchDestId?.() || 0)))) return true;
    const entityIds = new Set(entities.map(objectId).filter(Boolean));
    return sessions.some((session) => entityIds.has(currentCombatTargetId(session.actor)));
}

function startPlayerPartyRaid(leaderSession, boss, target, now) {
    const opener = selectRaidOpener(leaderSession);
    const raid = {
        bossId: objectId(boss),
        bossTemplateId: templateId(boss),
        targetId: objectId(target || boss),
        targetTemplateId: templateId(target || boss),
        openerId: objectId(opener?.actor),
        phase: 'opening',
        selectedAt: now,
        lastActiveAt: now
    };
    leaderSession.partyRaidEngagement = raid;
    return raid;
}

function syncPlayerPartyRaid(leaderSession, now = Date.now()) {
    if (playerPartySessions(leaderSession).length === 0) {
        if (leaderSession) leaderSession.partyRaidEngagement = undefined;
        return null;
    }

    const selectedRaidTarget = leaderDesignatedRaidTarget(leaderSession);
    const selectedBoss = selectedRaidTarget?.boss || null;
    const selectedTarget = selectedRaidTarget?.target || null;
    let raid = leaderSession.partyRaidEngagement;
    const existingBoss = raid
        ? RaidEntityIndex.bossByObjectId(world(), raid.bossId)
        : null;
    if (raid && (!existingBoss || existingBoss.isDead?.())) {
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
        if (!raid || (!selectedMatches && (
            raid.phase === 'opening' || raidHasPartyCombat(leaderSession, selectedRaid)
        ))) {
            raid = startPlayerPartyRaid(leaderSession, selectedBoss, selectedTarget, now);
        }
    }

    if (!raid) return null;
    if (selectedTarget && belongsToRaid(selectedTarget, raid)) {
        raid.targetId = objectId(selectedTarget);
        raid.targetTemplateId = templateId(selectedTarget);
    }
    const selectedMatches = selectedBoss && objectId(selectedBoss) === Number(raid.bossId || 0);
    if (raid.phase === 'opening') {
        if (!selectedMatches) {
            leaderSession.partyRaidEngagement = undefined;
            return null;
        }
        const openerStillAvailable = playerPartySessions(leaderSession)
            .some((session) => objectId(session.actor) === Number(raid.openerId || 0) && isOnlineCompanion(session, leaderSession));
        if (!openerStillAvailable) raid.openerId = objectId(selectRaidOpener(leaderSession)?.actor);
    }

    if (raidHasPartyCombat(leaderSession, raid)) {
        raid.phase = 'combat';
        raid.lastActiveAt = now;
    } else if (selectedMatches) {
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
        objectId(session.actor) === Number(raid.openerId || 0) &&
        objectId(target) === Number(raid.targetId || raid.bossId || 0);
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
    return raidEntities(raid).some((npc) => {
        if (!isRaidMinion(npc) || npc.isDead?.()) return false;
        const impairments = EffectStore.impairments(npc);
        return impairments.disabled;
    });
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

    const wasSeated = bot.state?.fetchSeated?.() === true;
    clearTarget(session, bot, threat);
    bot.attack?.abortCast?.(session, bot);
    bot.attack?.clearTimers?.();
    bot.state?.setHits?.(false);
    bot.state?.setCasts?.(false);
    bot.automation?.abortAll?.(bot);

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
    RAID_MINION_TEMPLATE_IDS,
    isRaidBoss,
    isRaidMinion,
    isProtectedRaidEntity,
    raidBossFor,
    raidBossByObjectId,
    raidEntityByObjectId,
    raidEntities,
    belongsToRaid,
    hasHeavyArmor,
    isRaidOpenerReady,
    selectRaidOpener,
    leaderDesignatedRaidBoss,
    leaderDesignatedRaidTarget,
    syncPlayerPartyRaid,
    canEngagePlayerPartyRaid,
    isEngagedPlayerPartyRaidTarget,
    hasControlledRaidMinion,
    clearTarget,
    retreat
};
