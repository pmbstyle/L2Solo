const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const WorkflowTelemetry = invoke('GameServer/Bot/AI/BotWorkflowTelemetry');
const PartyPulling = invoke('GameServer/Bot/AI/PartyPulling');
const PartyRevivalService = invoke('GameServer/Bot/AI/PartyRevivalService');
const BotPartyChat  = invoke('GameServer/Bot/AI/BotPartyChat');
const EffectStore    = invoke('GameServer/Effects/EffectStore');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const TradeService   = invoke('GameServer/Bot/TradeService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const PartyClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');

const FOLLOW_RUN_DISTANCE = 250;
const FOLLOW_RETARGET_DISTANCE = 900;
const FOLLOW_TARGET_DRIFT = 650;
const FOLLOW_TELEPORT_DISTANCE = 4500;
const FOLLOW_FORMATION_TOLERANCE = 45;
const STUCK_SAMPLE_INTERVAL_MS = 750;
// Aggression transfers threat; it must not consume every combat tick when
// the native transfer has not yet changed the monster's target.
const AGGRESSION_RETRY_MS = 5000;
// Newbie Guides only exist in the starter villages.  A companion should not
// abandon a player in the field just because its starter buffs have expired.
const NEWBIE_GUIDE_TOWN_RADIUS = 7500;
const NEWBIE_GUIDE_RECOVERY_MAX_LEVEL = 20;
const COMPANION_TOWN_ERRAND_RADIUS = 7500;
const COMPANION_TOWN_ERRAND_COOLDOWN_MS = 60000;
const TOWN_CENTER_FALLBACK_RADIUS = 1500;
const STARTER_GUIDE_TOWN_RADIUS = 1500;
const CRITICAL_COMBAT_HP_RATIO = 0.25;
const PARTY_RETREAT_DISTANCE = 500;
const PARTY_RETREAT_REPATH_MS = 1500;
const SUPPORT_APPROACH_TIMEOUT_MS = 10000;
const SUPPORT_APPROACH_REPATH_MS = 1500;
const SUPPORT_TARGET_DRIFT = 120;

function ratio(value, max) {
    if (!max) return 0;
    return Math.max(0, Math.min(1, value / max));
}

function isBusy(bot) {
    return !!(bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts());
}

function preemptForPriorityHeal(session, bot) {
    if (bot.state?.fetchCasts?.()) return false;

    const towards = bot.state?.fetchTowards?.();
    const interruptibleMove = towards === 'melee' || towards === 'move';
    if (!bot.state?.fetchHits?.() && !interruptibleMove) return false;

    bot.attack?.clearTimers?.();
    bot.attack?.resetQueuedEvent?.();
    bot.state?.setHits?.(false);
    bot.automation?.abortAll?.(bot);
    session.currentTargetId = undefined;
    bot.unselect?.();
    return true;
}

function point(actor) {
    return new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ());
}

function loc(actor) {
    return { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
}

function distance2d(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function isAtNewbieGuideTown(player, BotAI) {
    const guide = BotAI.getClosestNewbieGuide?.(player.fetchLocX(), player.fetchLocY());
    if (!guide) return false;

    return distance2d(
        { locX: player.fetchLocX(), locY: player.fetchLocY() },
        guide
    ) <= NEWBIE_GUIDE_TOWN_RADIUS;
}

function canRecoverAtNewbieGuide(bot, BotAI) {
    return Number(bot?.fetchLevel?.() || 0) <= NEWBIE_GUIDE_RECOVERY_MAX_LEVEL &&
        isAtNewbieGuideTown(bot, BotAI);
}

function beginNewbieGuideVisit(session, bot, playerSession, role) {
    session.preBuffLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.preBuffPlan = 'following';
    session.resumeAfterBuff = {
        plan: 'following',
        followPlayerSession: playerSession,
        partyCompanion: true,
        botStay: session.botStay === true,
        stayLocation: session.stayLocation ? { ...session.stayLocation } : null,
        role
    };
    session.plan = 'getting_buffed';
    session.currentTargetId = undefined;
    bot.unselect();
    bot.automation.abortAll(bot);
}

function townForCompanionErrand(player, BotAI) {
    const town = BotAI.getClosestTown?.(player.fetchLocX(), player.fetchLocY());
    if (!town) return null;

    const distance = distance2d(
        { locX: player.fetchLocX(), locY: player.fetchLocY() },
        { locX: town.x, locY: town.y }
    );
    if (distance > COMPANION_TOWN_ERRAND_RADIUS) return null;

    const playerLoc = {
        locX: player.fetchLocX(),
        locY: player.fetchLocY(),
        locZ: player.fetchLocZ()
    };
    // The town movement atlas is intentionally partial. Keep its precise
    // polygons where available, with a tight center fallback for towns known
    // to the respawn service. Starter villages outside that atlas are
    // recognized only beside their actual Newbie Guide, never by a broad
    // radius that also includes nearby farming fields.
    const guide = BotAI.getClosestNewbieGuide?.(player.fetchLocX(), player.fetchLocY());
    const besideStarterGuide = guide && distance2d(
        { locX: player.fetchLocX(), locY: player.fetchLocY() },
        guide
    ) <= STARTER_GUIDE_TOWN_RADIUS;
    const inTown = TownPathfinder.isInsideTown(playerLoc) || (
        distance <= TOWN_CENTER_FALLBACK_RADIUS
    ) || besideStarterGuide;

    return {
        town,
        distance,
        inTown
    };
}

function actorAdena(bot) {
    const adena = bot.backpack?.fetchItemFromSelfId?.(57);
    return Number(adena?.fetchAmount?.() || 0);
}

function plannedMarketPurchase(session, bot, town) {
    const plan = session.coldLifeState?.stats?.equipmentPlan;
    const selfId = Number(plan?.strategy === 'market' ? plan.target?.selfId : 0);
    if (!selfId) return null;
    if (bot.backpack?.fetchItemFromSelfId?.(selfId)) return null;

    const offer = MarketOpportunity.findOffers(selfId, {
        town: town.name,
        buyerCharacterId: bot.fetchId()
    }).find((candidate) => (
        Number(candidate.price) <= actorAdena(bot) &&
        candidate.sourceType === 'private_store' &&
        candidate.session?.actor &&
        String(candidate.session.accountId || '').startsWith('bot_')
    ));
    // Hot companions can transact only with a live bot merchant. Cold
    // listings have no world actor to walk to, while player-store settlement
    // still belongs to the native client request path.
    if (!offer) return null;

    return {
        kind: 'market_purchase',
        itemId: selfId,
        itemName: offer.itemName,
        price: Number(offer.price),
        target: {
            actorId: offer.session.actor.fetchId(),
            name: offer.session.actor.fetchName(),
            locX: offer.session.actor.fetchLocX(),
            locY: offer.session.actor.fetchLocY(),
            locZ: offer.session.actor.fetchLocZ(),
            town: offer.town || town.name
        }
    };
}

function companionTownErrand(session, bot, player, BotAI) {
    if (Date.now() - Number(session.lastCompanionTownErrandAt || 0) < COMPANION_TOWN_ERRAND_COOLDOWN_MS) return null;
    const townContext = townForCompanionErrand(player, BotAI);
    if (!townContext) return null;
    const { town, inTown } = townContext;

    // In town, every companion may settle its own short task.  In the field,
    // leaving the leader is reserved for an immediately useful resupply;
    // shopping and selling can wait until the party actually reaches town.
    if (!inTown) {
        if (!ShotStock.needsActorRestock(bot, 0)) return null;
        return {
            kind: 'restock_shots',
            target: {
                actorId: null,
                name: `${town.name} general shop`,
                locX: town.x,
                locY: town.y,
                locZ: town.z,
                town: town.name
            }
        };
    }

    const purchase = plannedMarketPurchase(session, bot, town);
    if (purchase) return purchase;

    const buyer = TradeService.findBestBuyerForActor(bot, World.user?.sessions || [], { town });
    if (buyer) {
        return {
            kind: 'sell_resources',
            target: {
                actorId: buyer.actor.fetchId(),
                name: buyer.actor.fetchName(),
                locX: buyer.actor.fetchLocX(),
                locY: buyer.actor.fetchLocY(),
                locZ: buyer.actor.fetchLocZ(),
                town: buyer.store.town || town.name
            }
        };
    }

    if (!ShotStock.needsActorRestock(bot, 0)) return null;
    return {
        kind: 'restock_shots',
        target: {
            actorId: null,
            name: `${town.name} general shop`,
            locX: town.x,
            locY: town.y,
            locZ: town.z,
            town: town.name
        }
    };
}

function beginCompanionTownErrand(session, bot, playerSession, errand, BotAI) {
    session.lastCompanionTownErrandAt = Date.now();
    session.preShopLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.resumeAfterShopping = {
        plan: 'following',
        followPlayerSession: playerSession,
        partyCompanion: true,
        botStay: session.botStay === true,
        stayLocation: session.stayLocation ? { ...session.stayLocation } : null
    };
    session.companionShopping = errand;
    session.shoppingTarget = errand.target;
    session.shoppingDoneAnnounced = false;
    session.plan = 'shopping';
    session.currentTargetId = undefined;
    bot.unselect();
    bot.automation.abortAll(bot);

    const detail = errand.kind === 'market_purchase'
        ? `${errand.itemName} from ${errand.target.name}`
        : errand.kind === 'sell_resources'
            ? `sell these resources to ${errand.target.name}`
            : 'restock my shots';
    BotPartyChat.announce(session, {
        priority: 'informational',
        key: `town-errand:${bot.fetchId()}:${errand.kind}`,
        templates: [
            `Quick ${detail}; then I'm back to camp.`,
            `Taking a moment to ${detail}, then returning.`
        ]
    });
}

function shouldKeepCurrentFollowMove(session, bot, player, leaderDistance) {
    const isMoving = !!session.moveTimer || bot.state.fetchTowards();
    if (!isMoving) return false;
    if ((session.stuckTicks || 0) >= 2) return false;
    if (
        bot.state.fetchTowards() === 'remote' &&
        Number(session.pendingSupportCast?.expiresAt || 0) > Date.now()
    ) {
        return true;
    }
    if (leaderDistance > FOLLOW_RETARGET_DISTANCE) return false;

    const target = session.lastFollowMoveTarget;
    if (!target) return false;
    return distance2d(target, loc(player)) <= FOLLOW_TARGET_DRIFT;
}

function standUp(session, bot) {
    if (!bot.state.fetchSeated()) return false;
    bot.state.setSeated(false);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function sitDown(session, bot) {
    if (bot.state.fetchSeated()) return false;
    bot.state.setSeated(true);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function roleDecisionSignature(decision) {
    return [
        decision?.role,
        decision?.action,
        decision?.reason,
        decision?.targetId,
        decision?.protectedId,
        decision?.threatSource,
        decision?.phase
    ].map((value) => value ?? '').join(':');
}

function recordRoleDecision(session, bot, action, reason, extra = {}) {
    const role = BotRoles.inferRole(bot);
    const previous = session.roleDecision;
    const current = {
        role,
        action,
        reason,
        at: Date.now(),
        ...extra
    };

    session.roleDecision = current;

    const signature = roleDecisionSignature(current);
    const shouldLog = !previous ||
        roleDecisionSignature(previous) !== signature ||
        current.at - (session.lastRoleDecisionLogAt || 0) > 10000;

    if (shouldLog) {
        session.lastRoleDecisionLogAt = current.at;
        const details = [
            current.targetId !== undefined && `target=${current.targetId}`,
            current.protectedId !== undefined && `protected=${current.protectedId}`,
            current.threatSource && `source=${current.threatSource}`,
            current.phase && `phase=${current.phase}`
        ].filter(Boolean).join(' ');
        console.info("BotRole :: %s %s/%s (%s)%s", bot.fetchName(), action, reason, role, details ? ` ${details}` : '');
    }
}

function castSkillOn(session, bot, Generics, target, skill, ctrl, announcement = null) {
    session.currentTargetId = target.fetchId();
    bot.select({ id: target.fetchId() });
    if (announcement) {
        BotPartyChat.expectSkillResult(session, {
            target,
            skill,
            ...announcement
        });
    }
    Generics.skillExec(session, bot, { id: target.fetchId(), selfId: skill.fetchSelfId(), ctrl });
}

function clearPendingSupportApproach(session, bot, { abortMove = false } = {}) {
    if (!session.pendingSupportApproach) return false;
    session.pendingSupportApproach = undefined;
    if (abortMove && bot.state?.fetchTowards?.() && !bot.state?.fetchHits?.() && !bot.state?.fetchCasts?.()) {
        bot.automation?.abortAll?.(bot);
    }
    return true;
}

function queueSupportSkillOn(session, bot, Generics, target, skill, ctrl, kind, announcement = null) {
    const skillDistance = Number(skill.fetchDistance?.()) || 0;
    const partyAura = skill.fetchTargetKind?.() === 'party' && skillDistance < 0;
    const castRange = partyAura ? Infinity : Math.max(0, skillDistance);
    if (point(bot).distance(point(target)) <= castRange) {
        clearPendingSupportApproach(session, bot, { abortMove: true });
        castSkillOn(session, bot, Generics, target, skill, ctrl, announcement);
        return 'cast';
    }

    const now = Date.now();
    const targetLoc = loc(target);
    const pending = session.pendingSupportApproach;
    const sameAction = pending &&
        Number(pending.targetId) === Number(target.fetchId()) &&
        Number(pending.skillId) === Number(skill.fetchSelfId());
    const targetDrift = sameAction && pending.targetLoc
        ? distance2d(pending.targetLoc, targetLoc)
        : Infinity;
    const shouldRepath = !sameAction ||
        !session.moveTimer ||
        !bot.state?.fetchTowards?.() ||
        targetDrift > SUPPORT_TARGET_DRIFT ||
        now - Number(pending.lastMoveAt || 0) >= SUPPORT_APPROACH_REPATH_MS;

    session.pendingSupportApproach = {
        targetId: target.fetchId(),
        skillId: skill.fetchSelfId(),
        ctrl,
        kind,
        announcement,
        startedAt: sameAction ? pending.startedAt : now,
        lastMoveAt: shouldRepath ? now : pending.lastMoveAt,
        targetLoc
    };

    if (shouldRepath) {
        bot.moveTo({ from: loc(bot), to: targetLoc });
    }
    return 'approach';
}

function resumePendingSupportApproach(session, bot, Generics, leaderSession) {
    const pending = session.pendingSupportApproach;
    if (!pending) return null;

    const targetSession = PartyAwareness.partySessions(leaderSession).find((memberSession) => (
        Number(memberSession.actor?.fetchId?.()) === Number(pending.targetId)
    ));
    const target = targetSession?.actor;
    const skill = bot.skillset?.fetchSkill?.(pending.skillId);
    if (!target || target.isDead?.() || !skill || Date.now() - pending.startedAt > SUPPORT_APPROACH_TIMEOUT_MS) {
        clearPendingSupportApproach(session, bot, { abortMove: true });
        BotSupportPlanner.cancelSupportCast(session, bot);
        return { handled: false, expired: true };
    }

    const result = queueSupportSkillOn(
        session,
        bot,
        Generics,
        target,
        skill,
        pending.ctrl,
        pending.kind,
        pending.announcement
    );
    return { handled: true, action: result, target, skill, kind: pending.kind };
}

function canAttemptAggression(session, target) {
    const previous = session.lastAggressionAttempt;
    const targetId = Number(target?.fetchId?.() || 0);
    const protectedId = Number(target?.fetchDestId?.() || 0);
    return !previous ||
        previous.targetId !== targetId ||
        previous.protectedId !== protectedId ||
        Date.now() - previous.at >= AGGRESSION_RETRY_MS;
}

function rememberAggressionAttempt(session, target) {
    session.lastAggressionAttempt = {
        targetId: Number(target.fetchId()),
        protectedId: Number(target.fetchDestId?.() || 0),
        at: Date.now()
    };
}

function pendingSupportShouldYield(session, bot, leaderSession, pullerActor, partyThreat) {
    const pending = session.pendingSupportApproach;
    if (!pending) return false;

    const targetSession = PartyAwareness.partySessions(leaderSession).find((memberSession) => (
        Number(memberSession.actor?.fetchId?.()) === Number(pending.targetId)
    ));
    const target = targetSession?.actor;
    if (!target || target.isDead?.()) return true;

    const targetHpRatio = ratio(target.fetchHp(), target.fetchMaxHp());
    const targetMpRatio = ratio(target.fetchMp(), target.fetchMaxMp());
    if (pending.kind === 'top_off' && targetHpRatio >= 0.70) return true;
    if (pending.kind === 'restore_mp' && targetMpRatio >= 0.55) return true;
    if (partyThreat && pending.kind === 'restore_mp') return true;
    if (partyThreat && String(pending.kind || '').startsWith('buff:')) return true;

    if (BotRoles.inferRole(bot) !== 'healer') return false;
    const emergency = weakestPartyMember(leaderSession, bot, pullerActor);
    if (emergency?.hpRatio < 0.45) return (
        pending.kind !== 'emergency_heal' ||
        Number(pending.targetId) !== Number(emergency.actor.fetchId())
    );
    return ratio(bot.fetchHp(), bot.fetchMaxHp()) < 0.55 &&
        Number(pending.targetId) !== Number(bot.fetchId());
}

function partyActorIds(leaderSession) {
    return new Set(PartyAwareness.partyActors(leaderSession)
        .map((actor) => actor.fetchId())
        .filter((id) => id !== null && id !== undefined));
}

function partyAggroMonsters(leaderSession) {
    const ids = partyActorIds(leaderSession);
    if (ids.size === 0) return [];

    const seen = new Set();
    return PartyAwareness.partyActors(leaderSession).flatMap((actor) => (
        // Match PartyAwareness' full NPC combat envelope. A ranged mob can
        // continue attacking from beyond the old 900-unit support check.
        World.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), 1500)
    ))
        .filter((npc) => {
            const id = npc.fetchId?.() || npc;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .filter((npc) => !BotRaidSafety.isProtectedRaidEntity(npc) || BotRaidSafety.isEngagedPlayerPartyRaidTarget(leaderSession, npc))
        .filter((npc) => npc.fetchAttackable() && !npc.isDead() && ids.has(npc.fetchDestId()));
}

function unsafeSupportMoment(bot, activeMobs) {
    // A selected target is not combat. Both the leader and companions retain
    // target ids after inspecting a creature or after a completed cast; using
    // those ids here made an idle party wait forever to refresh its buffs.
    // Only an NPC actually targeting the party, or this bot's active native
    // action, is unsafe for support.
    return activeMobs > 0 || isBusy(bot);
}

function partyMembersInSupportRange(leaderSession, bot, maxDistance = 900) {
    return PartyAwareness.partySessions(leaderSession)
        .filter((memberSession) => memberSession.actor && !memberSession.actor.isDead?.())
        .map((memberSession) => ({
            session: memberSession,
            actor: memberSession.actor,
            hpRatio: ratio(memberSession.actor.fetchHp(), memberSession.actor.fetchMaxHp()),
            mpRatio: ratio(memberSession.actor.fetchMp(), memberSession.actor.fetchMaxMp()),
            distance: point(bot).distance(point(memberSession.actor))
        }))
        .filter((entry) => entry.distance <= maxDistance);
}

function weakestPartyMember(leaderSession, bot, preferredActor = null, maxDistance = 900) {
    const members = partyMembersInSupportRange(leaderSession, bot, maxDistance)
        .filter((entry) => entry.actor !== bot)
        .sort((a, b) => a.hpRatio - b.hpRatio);
    const preferred = members.find((entry) => entry.actor === preferredActor);
    return preferred?.hpRatio < 0.95 ? preferred : (members[0] || null);
}

function weakestPartyVitals(leaderSession, bot) {
    return partyMembersInSupportRange(leaderSession, bot)
        .reduce((lowest, entry) => !lowest || entry.hpRatio < lowest.hpRatio ? entry : lowest, null);
}

function partySupportMembers(leaderSession, puller) {
    return PartyPulling.supportMembers(leaderSession, puller);
}

function announceUnexpectedNpcAdd(session, bot, leaderSession, partyThreat, leaderTargetId) {
    if (
        partyThreat?.type !== 'npc' ||
        partyThreat.source === 'party_pull' ||
        Number(partyThreat.actor?.fetchId?.() || 0) === Number(leaderTargetId || 0)
    ) {
        return false;
    }

    const protectedSession = PartyAwareness.partySessions(leaderSession).find((memberSession) => (
        Number(memberSession.actor?.fetchId?.() || 0) === Number(partyThreat.targetId || 0)
    ));
    const protectedActor = protectedSession?.actor;
    if (!protectedActor || protectedActor === bot) return false;

    const protectedRole = protectedSession === leaderSession ? 'leader' : BotRoles.inferRole(protectedActor);
    if (protectedRole !== 'leader' && protectedRole !== 'healer' && protectedRole !== 'buffer') return false;

    return BotPartyChat.announceNpcAdd(session, partyThreat.actor, protectedActor);
}

function moveToFollowTarget(session, bot, player) {
    const followTarget = followTargetFor(session, player);
    // Formation positions are deliberately offset from the leader.  Comparing
    // only against the leader made a bot repeatedly path to its current
    // position once it had reached that offset.
    if (distance2d(loc(bot), followTarget) <= FOLLOW_FORMATION_TOLERANCE) {
        session.lastFollowMoveTarget = null;
        return false;
    }
    session.lastFollowMoveTarget = followTarget;
    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: followTarget
    });
    return true;
}

function retreatFromThreat(session, bot, threat, player, rooted) {
    const retreatInProgress = Date.now() < Number(session.partyRetreatUntil || 0) &&
        (!!session.moveTimer || bot.state?.fetchTowards?.());
    session.currentTargetId = undefined;
    bot.unselect();
    bot.attack?.abortCast?.(session, bot);
    bot.attack?.clearTimers?.();
    bot.state?.setHits?.(false);

    // Damage wakeups can run this state several times before a 500-unit route
    // completes. Keep the existing escape movement instead of cancelling it
    // and returning without a replacement route on every cooldown tick.
    if (retreatInProgress) return true;

    bot.automation?.abortAll?.(bot);
    if (rooted) return false;

    const retreat = BotRetreatPlanner.retreat(session, bot, threat, {
        distance: PARTY_RETREAT_DISTANCE,
        preferredPoint: player
    });
    session.partyRetreatUntil = Date.now() + PARTY_RETREAT_REPATH_MS;
    session.lastFollowMoveTarget = retreat.to;
    return true;
}

function manaPriority(entry, pullerActor) {
    const role = BotRoles.inferRole(entry.actor);
    if (entry.actor === pullerActor) return 0;
    if (role === 'buffer') return 1;
    if (role === 'healer') return 2;
    if (role === 'mage') return 3;
    if (role === 'archer') return 4;
    return 5;
}

function rechargeThreshold(entry, pullerActor, emergencyTankOnly) {
    const role = BotRoles.inferRole(entry.actor);
    if (role === 'tank') return emergencyTankOnly ? 0.20 : (entry.actor === pullerActor ? 0.35 : 0.30);
    return 0.55;
}

function lowestManaPartyMember(leaderSession, bot, pullerActor = null, maxDistance = 900, { emergencyTankOnly = false } = {}) {
    return partyMembersInSupportRange(leaderSession, bot, maxDistance)
        .filter((entry) => entry.actor !== bot)
        .filter((entry) => BotRoles.needsPartyManaRecovery(entry.actor))
        .filter((entry) => !emergencyTankOnly || BotRoles.inferRole(entry.actor) === 'tank')
        .filter((entry) => entry.mpRatio < rechargeThreshold(entry, pullerActor, emergencyTankOnly))
        .sort((a, b) => (
            manaPriority(a, pullerActor) - manaPriority(b, pullerActor) ||
            a.mpRatio - b.mpRatio ||
            Number(a.actor.fetchId()) - Number(b.actor.fetchId())
        ))[0] || null;
}

function markPartyRecharge(leaderSession, bot, target, skill) {
    const castMs = Number(skill?.fetchCalculatedHitTime?.() || skill?.fetchHitTime?.() || 0);
    leaderSession.partyRecoveryCast = {
        providerId: bot.fetchId(),
        targetId: target.fetchId(),
        expiresAt: Date.now() + Math.max(1000, castMs + 1000)
    };
}

function partyHasBuffer(leaderSession, exceptActor = null) {
    return PartyAwareness.partySessions(leaderSession)
        .some((memberSession) => (
            memberSession.actor !== exceptActor &&
            BotRoles.inferRole(memberSession.actor) === 'buffer'
        ));
}

function returnToPartyAfterSupport(session, bot, player, target) {
    // A remote heal/buff may have made the support bot walk far away from the
    // formation.  The native cast owns that movement until the hit lands; the
    // next idle tick must head back to the leader instead of beginning combat
    // around the assisted target.
    if (point(target).distance(point(player)) > FOLLOW_RUN_DISTANCE) {
        session.returnToPartyAfterSupport = true;
    }
}

function activeBotPullTravel(session, pulling) {
    return pulling?.enabled === true &&
        pulling.puller?.session === session &&
        pulling.puller.kind === 'bot' &&
        ['approach', 'return'].includes(pulling.phase);
}

function pullBlockReason(session, botVitals, partyVitals, activeMobs, partySettings) {
    // pullMode is authoritative. autoTaunt is only a per-session mirror and
    // can briefly be stale after party/session lifecycle changes.
    if (partySettings?.pullMode === 'off' || session.autoTaunt === false) return 'manual_pull_off';
    if (session.botStay) return 'stay_order';
    if (session.currentTargetId) return 'already_assisting';
    if (partyVitals?.hpRatio < 0.65) return 'party_low_hp';
    if (botVitals.hpRatio < 0.55) return 'tank_low_hp';
    if (activeMobs >= 2) return 'active_mobs';
    return null;
}

function assistActionForRole(role) {
    if (role === 'archer' || role === 'mage') return 'ranged_assist';
    if (role === 'buffer') return 'buff_support';
    if (role === 'dagger') return 'flank_target';
    return 'assist_leader';
}

function supportCanMeleeAssist(bot, role) {
    return !['healer', 'buffer'].includes(role) || BotRoles.hasMeleeWeapon(bot);
}

function assistReasonForRole(role) {
    if (role === 'dagger') return 'close_assist';
    return 'leader_target';
}

function followTargetFor(session, player) {
    return PartyCompanionService.formationTargetFor(session) || {
        locX: player.fetchLocX(),
        locY: player.fetchLocY(),
        locZ: player.fetchLocZ()
    };
}

function deliverPurchasedResources(session, bot, playerSession) {
    const delivery = session.pendingResourceDelivery;
    if (!delivery) return false;
    if (delivery.playerSession !== playerSession || Number(delivery.playerId) !== Number(playerSession.actor?.fetchId?.())) {
        session.pendingResourceDelivery = undefined;
        return false;
    }
    if (delivery.tradeId && session.activeTrade?.id === delivery.tradeId) {
        recordRoleDecision(session, bot, 'deliver_resources', 'trade_pending_confirmation', { targetId: delivery.playerId });
        return true;
    }
    if (Number(delivery.retryAt || 0) > Date.now()) return false;
    if (point(bot).distance(point(playerSession.actor)) > 350) {
        if (!bot.state?.fetchTowards?.()) {
            bot.moveTo({ from: loc(bot), to: loc(playerSession.actor) });
        }
        recordRoleDecision(session, bot, 'deliver_resources', 'return_to_leader', { targetId: delivery.playerId });
        return true;
    }
    let partyThreat = null;
    try { partyThreat = PartyAwareness.findThreatTargetingParty(playerSession); } catch (_) { /* lightweight test/session */ }
    const leaderBusy = !!(
        playerSession.actor.state?.fetchHits?.() ||
        playerSession.actor.state?.fetchCasts?.() ||
        playerSession.actor.state?.fetchCombats?.()
    );
    if (partyThreat || leaderBusy) {
        const now = Date.now();
        if (now - Number(session.resourceTradeWaitAnnouncedAt || 0) > 15000) {
            session.resourceTradeWaitAnnouncedAt = now;
            BotPartyChat.announce(session, {
                priority: 'informational',
                key: `resource-delivery-wait:${bot.fetchId()}:${delivery.purchasedAt}`,
                templates: ['I have the supplies. I will open trade as soon as the party is safe.']
            });
        }
        recordRoleDecision(session, bot, 'deliver_resources', 'wait_for_safe_trade', { targetId: delivery.playerId });
        return false;
    }
    const trade = invoke('GameServer/Bot/BotTradeService').startBotTradeWithOffer(
        session,
        playerSession,
        delivery.objectId,
        delivery.amount,
        { workflowId: delivery.workflowId, supplyDelivery: true }
    );
    if (!trade.ok) {
        if (trade.reason === 'too_far') return false;
        delivery.retryAt = Date.now() + 10000;
        BotPartyChat.announce(session, {
            priority: 'informational',
            key: `resource-delivery-failed:${bot.fetchId()}:${delivery.purchasedAt}`,
            templates: [`I brought ${delivery.itemName}, but could not open trade (${trade.reason}).`]
        });
        WorkflowTelemetry.recordSupply(delivery.workflowId, 'trade', {
            botId: bot.fetchId(),
            playerId: delivery.playerId,
            amount: delivery.amount
        }, 'failed', trade.reason || 'trade_open_failed', { terminal: false });
        return false;
    }
    delivery.tradeId = trade.trade?.id || trade.id || null;
    delivery.retryAt = undefined;
    BotPartyChat.announce(session, {
        priority: 'informational',
        key: `resource-delivery:${bot.fetchId()}:${delivery.purchasedAt}`,
        templates: [`I brought ${delivery.amount} ${delivery.itemName}. Please confirm the trade.`]
    });
    WorkflowTelemetry.recordSupply(delivery.workflowId, 'trade', {
        botId: bot.fetchId(),
        playerId: delivery.playerId,
        amount: delivery.amount,
        objectId: delivery.objectId
    }, 'pending', 'native_trade_open');
    recordRoleDecision(session, bot, 'deliver_resources', 'native_trade_open', { targetId: delivery.playerId });
    return true;
}

module.exports = {
    deliverPurchasedResources,

    tick(session, bot, Generics, BotAI) {
        const playerSession = session.followPlayerSession;
        if (session.partyCompanion !== true) {
            session.plan = 'hunting';
            session.followPlayerSession = null;
            session.roleDecision = null;
            return;
        }

        if (!playerSession || !playerSession.actor || !playerSession.actor.fetchIsOnline()) {
            session.plan = 'hunting';
            session.roleDecision = null;
            BotAI.say(session, "My companion has disconnected. Heading back to hunt.");
            return;
        }

        const player = playerSession.actor;
        if (player.isDead?.()) {
            // Do this before the provider is selected: a solo healer can be
            // the first and only companion tick after the leader dies.
            PartyPulling.cancelForRevival(playerSession);
        }
        // Resurrection is autonomous.  It must win over follow/catch-up and
        // over a stale pull target; chat is only conversation, never a switch
        // required to make companions revive their leader.
        const revival = PartyRevivalService.tick(session, playerSession, Generics);
        if (revival.handled) {
            recordRoleDecision(session, bot, 'resurrect_party', revival.source || 'waiting', {
                targetId: revival.target?.fetchId?.() || revival.targetId || null
            });
            return;
        }
        if (player.isDead?.()) {
            if (!revival.blockedBy) {
                session.currentTargetId = undefined;
                bot.unselect();
                bot.attack?.abortCast?.(session, bot);
                bot.attack?.clearTimers?.();
                bot.state?.setHits?.(false);
                bot.state?.setCasts?.(false);
                bot.automation?.abortAll?.(bot);
            }
            recordRoleDecision(
                session,
                bot,
                'wait_for_resurrection',
                revival.blockedBy ? `blocked_${revival.blockedBy}` : 'awaiting_resurrection',
                { targetId: player.fetchId() }
            );
            // During an actual fight, leave the normal combat branch active
            // so the living party can finish it. Once it clears, the next tick
            // immediately schedules the prioritized leader resurrection.
            if (!revival.blockedBy) return;
        }
        if (!player.isDead?.() && deliverPurchasedResources(session, bot, playerSession)) return;
        const role = BotRoles.inferRole(bot);
        const distance = point(bot).distance(point(player));
        const leaderSeated = player.state?.fetchSeated?.() === true;
        const restFormationTarget = leaderSeated ? followTargetFor(session, player) : null;
        const restFormationDistance = restFormationTarget
            ? distance2d(loc(bot), restFormationTarget)
            : distance;
        const partySettings = PartyCompanionService.getSettings(playerSession);
        const combatMode = partySettings.combatMode || 'assist';
        const partyRaid = BotRaidSafety.syncPlayerPartyRaid(playerSession);
        if (partyRaid) PartyPulling.cancel(playerSession);
        if (partyRaid?.phase === 'opening') {
            const raidBoss = (World.npc?.spawns || []).find((npc) => (
                Number(npc.fetchId?.()) === Number(partyRaid.bossId)
            ));
            const isOpener = Number(bot.fetchId()) === Number(partyRaid.openerId || 0);
            const openerSession = PartyAwareness.partySessions(playerSession).find((memberSession) => (
                Number(memberSession.actor?.fetchId?.()) === Number(partyRaid.openerId || 0)
            ));
            const opener = openerSession?.actor;
            const openerReady = BotRaidSafety.isRaidOpenerReady(opener);
            if (!openerReady) {
                if (role === 'healer' && opener && !isBusy(bot)) {
                    if (standUp(session, bot)) {
                        recordRoleDecision(session, bot, 'prepare_raid', 'stand_to_heal_opener', {
                            targetId: opener.fetchId(),
                            openerId: partyRaid.openerId
                        });
                        return;
                    }
                    const impairments = EffectStore.impairments(bot);
                    const healSkill = BotSkillCapabilities.selectHealSkill(bot, {
                        emergency: ratio(opener.fetchHp(), opener.fetchMaxHp()) < 0.45
                    });
                    const canHeal = healSkill && !impairments.silenced &&
                        bot.canUseSkill?.(healSkill) !== false &&
                        bot.fetchMp() >= Number(healSkill.fetchConsumedMp?.() || 0);
                    if (canHeal) {
                        const result = queueSupportSkillOn(
                            session,
                            bot,
                            Generics,
                            opener,
                            healSkill,
                            false,
                            'raid_opener_recovery'
                        );
                        recordRoleDecision(session, bot, result === 'cast' ? 'heal_party' : 'move_for_support', 'prepare_raid_opener', {
                            targetId: opener.fetchId(),
                            openerId: partyRaid.openerId
                        });
                        return;
                    }
                }
                recordRoleDecision(session, bot, 'hold_for_raid_opener', 'opener_recovering', {
                    targetId: partyRaid.bossId,
                    openerId: partyRaid.openerId || null
                });
                return;
            }
            if (isOpener && raidBoss && !isBusy(bot)) {
                if (standUp(session, bot)) {
                    recordRoleDecision(session, bot, 'prepare_raid', 'stand_before_opening', {
                        targetId: raidBoss.fetchId(),
                        openerId: partyRaid.openerId
                    });
                    return;
                }
                session.currentTargetId = raidBoss.fetchId();
                bot.select({ id: raidBoss.fetchId() });
                recordRoleDecision(session, bot, 'open_raid', 'player_designated_raid_target', {
                    targetId: raidBoss.fetchId()
                });
                BotAI.executeCombat(session, bot, raidBoss, Generics, {
                    playerPartyRaidLeaderSession: playerSession
                });
            } else {
                if (session.currentTargetId === Number(partyRaid.bossId)) {
                    session.currentTargetId = undefined;
                    bot.unselect();
                }
                recordRoleDecision(session, bot, 'hold_for_raid_opener', isOpener ? 'opener_busy' : 'tank_opens_first', {
                    targetId: partyRaid.bossId,
                    openerId: partyRaid.openerId || null
                });
            }
            return;
        }
        const selectedLeaderTargetId = PartyAwareness.leaderCombatTargetId(playerSession);
        // A player-designated pull is intentional even when the ordinary
        // combat posture is Protect or Passive.  Those modes should not make
        // the party ignore the leader's selected pull target.
        const configuredLeaderTargetId = combatMode === 'assist' || partySettings.pullMode === 'leader'
            ? selectedLeaderTargetId
            : undefined;
        PartyPulling.observeLeaderTarget(playerSession, partySettings, configuredLeaderTargetId);
        let pulling = PartyPulling.current(playerSession, partySettings);
        if (partyRaid) {
            pulling = { enabled: false, target: null, puller: null, engageable: false, phase: null };
        }
        const rawPartyThreat = PartyAwareness.findThreatTargetingParty(playerSession);
        if (rawPartyThreat?.type === 'raid') {
            PartyPulling.cancel(playerSession);
            if (BotRaidSafety.retreat(session, bot, rawPartyThreat.actor)) {
                recordRoleDecision(session, bot, 'retreat', 'raid_entity_protected', {
                    targetId: rawPartyThreat.actor.fetchId?.() || null,
                    protectedId: rawPartyThreat.targetId || null
                });
            }
            return;
        }
        const holdingPulledTarget = pulling.target && !pulling.engageable;
        const rawThreatIsHeldPull = holdingPulledTarget &&
            Number(rawPartyThreat?.actor?.fetchId?.()) === Number(pulling.target.fetchId());
        // While the puller is away from camp, mobs attacking only that puller
        // are part of the delivery, not a signal for the whole formation to
        // run out. Once the puller returns (or becomes critical), ranged adds
        // remain normal threats and the party will go finish them.
        const pullerAwayFromCamp = PartyPulling.travellingPullerAwayFromCamp(playerSession, pulling);
        const rawThreatOnlyTargetsTravellingPuller = pullerAwayFromCamp &&
            Number(rawPartyThreat?.targetId || 0) === Number(pulling.puller?.actor?.fetchId?.() || 0) &&
            ratio(pulling.puller.actor.fetchHp(), pulling.puller.actor.fetchMaxHp()) >= CRITICAL_COMBAT_HP_RATIO;
        let partyThreat = pulling.engageable && pulling.target
            ? {
                type: 'npc',
                actor: pulling.target,
                targetId: pulling.puller.actor.fetchId(),
                source: 'party_pull'
            }
            : (rawThreatIsHeldPull || rawThreatOnlyTargetsTravellingPuller || (combatMode === 'passive' && rawPartyThreat?.targetId !== bot.fetchId())
            ? null
            : rawPartyThreat);
        let partyAggroCache = null;
        const currentPartyAggroMonsters = () => {
            if (partyAggroCache === null) partyAggroCache = partyAggroMonsters(playerSession);
            return partyAggroCache;
        };
        const leaderTargetId = partyRaid?.phase === 'combat'
            ? Number(partyRaid.bossId)
            : (pulling.enabled ? undefined : configuredLeaderTargetId);
        announceUnexpectedNpcAdd(session, bot, playerSession, partyThreat, leaderTargetId);
        const impairments = EffectStore.impairments(bot);

        if (impairments.disabled) {
            clearPendingSupportApproach(session, bot, { abortMove: true });
            session.currentTargetId = undefined;
            bot.unselect();
            recordRoleDecision(session, bot, 'disabled', 'debuff_control');
            return;
        }

        const currentLoc = { x: bot.fetchLocX(), y: bot.fetchLocY() };
        if (!session.lastTickLoc) {
            session.lastTickLoc = currentLoc;
            session.stuckTicks = 0;
        }

        const movedDist = Math.sqrt((currentLoc.x - session.lastTickLoc.x) ** 2 + (currentLoc.y - session.lastTickLoc.y) ** 2);
        session.lastTickLoc = currentLoc;

        const isMoving = !!session.moveTimer || bot.state.fetchTowards();
        const now = Date.now();
        const canSampleStuck = now - Number(session.lastStuckSampleAt || 0) >= STUCK_SAMPLE_INTERVAL_MS;
        if (isMoving && movedDist < 10 && canSampleStuck) {
            session.stuckTicks = (session.stuckTicks || 0) + 1;
            session.lastStuckSampleAt = now;
        } else if (!isMoving || movedDist >= 10) {
            session.stuckTicks = 0;
            session.lastStuckSampleAt = now;
        }

        const seatedTooFar = leaderSeated
            ? distance > FOLLOW_RUN_DISTANCE && restFormationDistance > FOLLOW_FORMATION_TOLERANCE
            : distance > FOLLOW_RUN_DISTANCE;
        if (bot.state.fetchSeated() && (partyThreat || leaderTargetId || seatedTooFar)) {
            session.plan = 'following';
            session.currentTargetId = partyThreat?.actor?.fetchId?.() || leaderTargetId || undefined;
            standUp(session, bot);
            recordRoleDecision(
                session,
                bot,
                partyThreat || leaderTargetId ? assistActionForRole(role) : 'follow_leader',
                partyThreat ? 'party_under_attack' : (leaderTargetId ? assistReasonForRole(role) : 'leader_moved')
            );
            return;
        }

        if (impairments.rooted && !partyThreat && !leaderTargetId && distance > FOLLOW_RUN_DISTANCE) {
            recordRoleDecision(session, bot, 'hold_position', 'rooted');
            return;
        }

        // Pulling has its own route recovery.  Generic stuck samples must not
        // teleport the assigned puller: between geodata waypoints they can
        // report no movement even though its server-stepped route is healthy.
        // A truly distant puller may still use the normal catch-up teleport.
        const pullerTravelling = activeBotPullTravel(session, pulling);
        if (!pullerTravelling && (session.stuckTicks >= 3 || distance > FOLLOW_TELEPORT_DISTANCE)) {
            session.stuckTicks = 0;
            recordRoleDecision(session, bot, 'follow_leader', distance > FOLLOW_TELEPORT_DISTANCE ? 'catch_up' : 'unstuck');
            const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
            if (TeleportTo && typeof TeleportTo === 'function') {
                const targetLoc = {
                    ...followTargetFor(session, player)
                };
                TeleportTo(session, bot, targetLoc);
                BotPartyChat.announce(session, {
                    priority: 'informational',
                    key: `catch-up:${bot.fetchId()}`,
                    templates: ['Caught up.']
                });
            }
            return;
        }

        if (pendingSupportShouldYield(session, bot, playerSession, pulling.puller?.actor, partyThreat || leaderTargetId)) {
            clearPendingSupportApproach(session, bot, { abortMove: true });
            BotSupportPlanner.cancelSupportCast(session, bot);
        }
        const pendingSupport = resumePendingSupportApproach(session, bot, Generics, playerSession);
        if (pendingSupport?.handled) {
            const pendingKind = String(pendingSupport.kind || '');
            const pendingIsBuff = pendingKind.startsWith('buff:');
            const supportAction = pendingSupport.action === 'cast'
                ? (pendingIsBuff ? 'cast_support' : 'cast_heal')
                : 'move_for_support';
            recordRoleDecision(
                session,
                bot,
                supportAction,
                pendingIsBuff ? pendingKind.slice('buff:'.length) : pendingSupport.kind,
                { targetId: pendingSupport.target.fetchId(), skillId: pendingSupport.skill.fetchSelfId() }
            );
            return;
        }

        const botVitals = {
            hpRatio: ratio(bot.fetchHp(), bot.fetchMaxHp()),
            mpRatio: ratio(bot.fetchMp(), bot.fetchMaxMp())
        };
        const leaderVitals = {
            hpRatio: ratio(player.fetchHp(), player.fetchMaxHp()),
            mpRatio: ratio(player.fetchMp(), player.fetchMaxMp())
        };
        const partyVitals = weakestPartyVitals(playerSession, bot) || leaderVitals;
        const botRecovering = botVitals.hpRatio < 0.95 || (
            BotRoles.shouldRestForMana(bot) && botVitals.mpRatio < 0.95
        );

        if (session.returnToPartyAfterSupport && !isBusy(bot)) {
            session.returnToPartyAfterSupport = false;
            session.currentTargetId = undefined;
            bot.unselect();
            if (distance > FOLLOW_RUN_DISTANCE) {
                moveToFollowTarget(session, bot, player);
                recordRoleDecision(session, bot, 'follow_leader', 'return_after_support');
                return;
            }
        }

        if (!partyThreat && !leaderTargetId && leaderSeated) {
            session.currentTargetId = undefined;
            bot.unselect();

            if (distance > FOLLOW_RUN_DISTANCE && restFormationDistance > FOLLOW_FORMATION_TOLERANCE) {
                standUp(session, bot);
                recordRoleDecision(session, bot, 'rest_with_leader', 'move_near_sitting_leader');
                if (!shouldKeepCurrentFollowMove(session, bot, player, distance)) {
                    moveToFollowTarget(session, bot, player);
                }
                return;
            }

            session.lastFollowMoveTarget = null;
            sitDown(session, bot);
            recordRoleDecision(session, bot, 'rest_with_leader', 'leader_sitting');
            return;
        }

        if (!partyThreat && !leaderTargetId && bot.state.fetchSeated() && !leaderSeated && !botRecovering) {
            standUp(session, bot);
            recordRoleDecision(session, bot, 'follow_leader', 'leader_stood_ready');
            return;
        }

        const isActiveBotPuller = pulling.enabled &&
            pulling.puller?.kind === 'bot' &&
            pulling.puller?.session === session &&
            !!pulling.target;
        // The puller is the one companion who must not sit while a living
        // pull target is still assigned. A held incoming target is hidden
        // from the camp until delivery, so without this guard low HP could
        // make the puller sit in front of the mob it is returning with.
        const needsMpRecovery = BotRoles.shouldRestForMana(bot) && botVitals.mpRatio < 0.15;
        if (!partyThreat && !leaderTargetId && !isActiveBotPuller && (botVitals.hpRatio < 0.30 || needsMpRecovery)) {
            // Do not leave a hunting field just to recover.  This shortcut is
            // available only when the companion is already in a starter town
            // with a Newbie Guide, where characters through level 20 can
            // recover and renew their blessing before returning to the party.
            if (canRecoverAtNewbieGuide(bot, BotAI)) {
                beginNewbieGuideVisit(session, bot, playerSession, role);
                recordRoleDecision(session, bot, botVitals.hpRatio < 0.30 ? 'recover_hp' : 'save_mp', 'newbie_guide_recovery');
                BotPartyChat.announce(session, {
                    priority: 'coordination',
                    key: `recover-guide:${bot.fetchId()}`,
                    templates: [
                        'HP/MP is low. Recovering at the Newbie Guide, then returning.',
                        'Short Newbie Guide stop for HP/MP; I will return after.'
                    ]
                });
                return;
            }

            session.plan = 'resting';
            delete session.explicitRestOrder;
            session.currentTargetId = undefined;
            bot.unselect();
            sitDown(session, bot);
            recordRoleDecision(session, bot, botVitals.hpRatio < 0.30 ? 'recover_hp' : 'save_mp', 'resting');
            BotPartyChat.announce(session, {
                priority: 'coordination',
                key: `recover-sit:${bot.fetchId()}`,
                templates: ['HP/MP is low. Sitting to recover.', 'Need a short sit for HP/MP.']
            });
            return;
        }

        let acted = false;
        let keepRoleDecision = false;

        const buffsNeedRefresh = BotBuffs.needsNewbieRefresh(bot);
        if (buffsNeedRefresh) {
            const unsafeToRefresh = unsafeSupportMoment(bot, currentPartyAggroMonsters().length);
            const inTown = TownPathfinder.isInsideTown({
                locX: player.fetchLocX(),
                locY: player.fetchLocY(),
                locZ: player.fetchLocZ()
            });
            const expired = BotBuffs.needsNewbieRefresh(bot, 0);
            const nearbyGuide = isAtNewbieGuideTown(player, BotAI);
            const canMakeFieldBuffTrip = !inTown && expired && nearbyGuide && !partyHasBuffer(playerSession, bot);

            if (unsafeToRefresh) {
                recordRoleDecision(session, bot, 'refresh_buffs', 'wait_for_safe_moment', {
                    missingBuffs: BotBuffs.missingNewbieBuffs(bot, BotBuffs.REFRESH_THRESHOLD_MS)
                });
                keepRoleDecision = true;
            } else if (!nearbyGuide || (!inTown && !canMakeFieldBuffTrip)) {
                recordRoleDecision(session, bot, 'refresh_buffs', 'wait_for_newbie_guide_town', {
                    missingBuffs: BotBuffs.missingNewbieBuffs(bot, BotBuffs.REFRESH_THRESHOLD_MS)
                });
                keepRoleDecision = true;
            } else {
                beginNewbieGuideVisit(session, bot, playerSession, role);
                recordRoleDecision(session, bot, 'refresh_buffs', 'newbie_blessing', {
                    missingBuffs: BotBuffs.missingNewbieBuffs(bot, BotBuffs.REFRESH_THRESHOLD_MS)
                });
                BotPartyChat.announce(session, {
                    priority: 'coordination',
                    key: `newbie-rebuff:${bot.fetchId()}`,
                    templates: [
                        'Newbie buffs are fading. Refreshing, then returning.',
                        'Quick Newbie Guide rebuff; I will be right back.'
                    ]
                });
                return;
            }
        }

        if (!partyThreat && !leaderTargetId && !isBusy(bot)) {
            const errand = companionTownErrand(session, bot, player, BotAI);
            if (errand) {
                beginCompanionTownErrand(session, bot, playerSession, errand, BotAI);
                recordRoleDecision(session, bot, 'town_errand', errand.kind, {
                    town: errand.target.town,
                    itemId: errand.itemId || null
                });
                return;
            }
        }

        const supportBuffTarget = BotSupportPlanner.nextAction(
            bot,
            partySupportMembers(playerSession, pulling.puller),
            PartyPulling.supportProviders(playerSession)
        );
        const routineHealCandidate = role === 'healer' ? BotSkillCapabilities.selectHealSkill(bot) : null;
        const emergencyHealCandidate = role === 'healer' ? BotSkillCapabilities.selectHealSkill(bot, { emergency: true }) : null;
        const rechargeSkill = role === 'healer' ? BotSkillCapabilities.manaRechargeSkill(bot) : null;
        const woundedPartyMember = role === 'healer'
            ? weakestPartyMember(playerSession, bot, pulling.puller?.actor)
            : null;
        const woundedPartyCount = role === 'healer'
            ? partyMembersInSupportRange(playerSession, bot).filter((entry) => entry.hpRatio < 0.70).length
            : 0;
        const groupHealCandidate = role === 'healer' && woundedPartyCount >= 2
            ? BotSkillCapabilities.selectHealSkill(bot, { group: true })
            : null;
        const canAffordHeal = (skill) => !!skill && bot.canUseSkill?.(skill) !== false && bot.fetchMp() >= skill.fetchConsumedMp();
        const routineHealSkill = routineHealCandidate;
        const emergencyHealSkill = canAffordHeal(emergencyHealCandidate) ? emergencyHealCandidate : routineHealCandidate;
        const groupHealSkill = canAffordHeal(groupHealCandidate) ? groupHealCandidate : null;
        const topOffHealSkill = groupHealSkill || routineHealSkill;
        const safeManaPartyMember = role === 'healer' && rechargeSkill && !partyThreat && !leaderTargetId
            ? lowestManaPartyMember(playerSession, bot, pulling.puller?.actor)
            : null;
        // A tank remains a standing melee role, but below one taunt reserve it
        // becomes an emergency Recharge target even during combat. Healing
        // still wins below, and a healer currently being attacked will not
        // stop to channel mana into somebody else.
        const emergencyTankManaMember = role === 'healer' && rechargeSkill && partyThreat &&
            Number(partyThreat.targetId || 0) !== Number(bot.fetchId())
            ? lowestManaPartyMember(playerSession, bot, pulling.puller?.actor, 900, { emergencyTankOnly: true })
            : null;
        const manaPartyMember = emergencyTankManaMember || safeManaPartyMember;
        // Healing is the healer's first obligation.  Do not queue a regular
        // party buff and then overwrite it with a heal in this same AI tick.
        const healerNeedsAction = role === 'healer' && (
            (woundedPartyMember?.hpRatio < 0.45 && canAffordHeal(emergencyHealSkill)) ||
            (woundedPartyMember?.hpRatio < 0.70 && botVitals.mpRatio >= 0.35 && canAffordHeal(topOffHealSkill)) ||
            (botVitals.hpRatio < 0.55 && botVitals.mpRatio >= 0.25 && canAffordHeal(emergencyHealSkill))
        );
        if (healerNeedsAction && !impairments.silenced) {
            preemptForPriorityHeal(session, bot);
        }
        const healerCanCast = (skill) => canAffordHeal(skill) && !isBusy(bot) && !impairments.silenced;
        const rebuff = !partyThreat && !leaderTargetId && !isBusy(bot)
            ? BotSupportPlanner.rebuffRequest(bot, PartyPulling.supportProviders(playerSession))
            : null;
        if (rebuff && rebuff.provider !== bot && Date.now() - (session.lastRebuffRequestAt || 0) > 90000) {
            session.lastRebuffRequestAt = Date.now();
            BotPartyChat.announce(session, {
                priority: 'coordination',
                key: `rebuff:${rebuff.provider.fetchId()}:${rebuff.skill.fetchSelfId()}`,
                templates: [
                    `${rebuff.provider.fetchName()}, refresh ${rebuff.skill.fetchName()} when safe?`,
                    `${rebuff.provider.fetchName()}, ${rebuff.skill.fetchName()} is fading.`
                ]
            });
        }
        // A routine buff must never take the action slot from a live party
        // threat. The target may be a social ranged add that is still outside
        // melee range, so let the normal defence branch react immediately.
        if (!acted && !partyThreat && !leaderTargetId && supportBuffTarget && !healerNeedsAction) {
            const activeMobs = currentPartyAggroMonsters().length;
            if (unsafeSupportMoment(bot, activeMobs)) {
                recordRoleDecision(session, bot, 'buff_party', 'wait_for_safe_moment', {
                    buff: supportBuffTarget.effect,
                    targetId: supportBuffTarget.target.fetchId(),
                    activeMobs
                });
                keepRoleDecision = true;
            } else if (impairments.silenced) {
                recordRoleDecision(session, bot, 'save_mp', 'silenced');
                keepRoleDecision = true;
            } else if (bot.fetchMp() < supportBuffTarget.skill.fetchConsumedMp() || botVitals.mpRatio < 0.35) {
                recordRoleDecision(session, bot, 'save_mp', 'low_mp_for_buff', {
                    buff: supportBuffTarget.effect,
                    targetId: supportBuffTarget.target.fetchId()
                });
                keepRoleDecision = true;
            } else {
                acted = true;
                // A queued cast is not a buff yet. The reservation begins in
                // Attack.remoteHit once the native cast has actually started.
                BotSupportPlanner.queueSupportCast(session, supportBuffTarget);
                const supportResult = queueSupportSkillOn(
                    session,
                    bot,
                    Generics,
                    supportBuffTarget.target,
                    supportBuffTarget.skill,
                    false,
                    `buff:${supportBuffTarget.effect}`
                );
                returnToPartyAfterSupport(session, bot, player, supportBuffTarget.target);
                recordRoleDecision(session, bot, supportResult === 'cast' ? 'cast_support' : 'move_for_support', supportBuffTarget.effect, {
                    buff: supportBuffTarget.effect,
                    skillId: supportBuffTarget.skill.fetchSelfId(),
                    targetId: supportBuffTarget.target.fetchId()
                });
            }
        }

        if (!acted && role === 'healer') {
            if (woundedPartyMember?.hpRatio < 0.45 && healerCanCast(emergencyHealSkill)) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_party', 'emergency_heal', { targetId: woundedPartyMember.actor.fetchId() });
                queueSupportSkillOn(session, bot, Generics, woundedPartyMember.actor, emergencyHealSkill, false, 'emergency_heal', { kind: 'emergency_heal' });
                returnToPartyAfterSupport(session, bot, player, woundedPartyMember.actor);
            } else if (botVitals.hpRatio < 0.55 && botVitals.mpRatio >= 0.25 && healerCanCast(emergencyHealSkill)) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_self', 'self_preservation', { targetId: bot.fetchId() });
                queueSupportSkillOn(session, bot, Generics, bot, emergencyHealSkill, false, 'self_preservation');
            } else if (woundedPartyMember?.hpRatio < 0.70 && botVitals.mpRatio >= 0.35 && healerCanCast(topOffHealSkill)) {
                acted = true;
                const groupHeal = topOffHealSkill?.fetchTargetKind?.() === 'party';
                recordRoleDecision(session, bot, 'heal_party', groupHeal ? 'group_heal' : 'top_off', {
                    targetId: woundedPartyMember.actor.fetchId(),
                    woundedCount: woundedPartyCount,
                    skillId: topOffHealSkill.fetchSelfId()
                });
                queueSupportSkillOn(session, bot, Generics, woundedPartyMember.actor, topOffHealSkill, false, groupHeal ? 'group_heal' : 'top_off');
                returnToPartyAfterSupport(session, bot, player, woundedPartyMember.actor);
            } else if (woundedPartyMember?.hpRatio < 0.70 && botVitals.mpRatio < 0.35) {
                recordRoleDecision(session, bot, 'save_mp', woundedPartyMember.hpRatio < 0.45 ? 'low_mp_emergency' : 'party_not_critical');
                if (woundedPartyMember.hpRatio < 0.45 && emergencyHealSkill && bot.fetchMp() < emergencyHealSkill.fetchConsumedMp()) {
                    BotPartyChat.announceHealManaShortage(session, woundedPartyMember.actor);
                }
                keepRoleDecision = true;
            } else if (impairments.silenced) {
                recordRoleDecision(session, bot, 'save_mp', 'silenced');
                keepRoleDecision = true;
            } else if (botVitals.mpRatio < 0.25) {
                recordRoleDecision(session, bot, 'save_mp', 'low_mp');
                keepRoleDecision = true;
            } else if (manaPartyMember && rechargeSkill && !isBusy(bot) && !healerNeedsAction) {
                acted = true;
                markPartyRecharge(playerSession, bot, manaPartyMember.actor, rechargeSkill);
                recordRoleDecision(session, bot, 'recharge_party', emergencyTankManaMember ? 'restore_tank_control_mp' : 'restore_mp', {
                    targetId: manaPartyMember.actor.fetchId(),
                    skillId: rechargeSkill.fetchSelfId()
                });
                queueSupportSkillOn(session, bot, Generics, manaPartyMember.actor, rechargeSkill, false, 'restore_mp');
                returnToPartyAfterSupport(session, bot, player, manaPartyMember.actor);
            } else if (!routineHealSkill && !emergencyHealSkill && !groupHealSkill && woundedPartyMember?.hpRatio < 0.70) {
                recordRoleDecision(session, bot, 'cannot_heal', 'no_learned_heal');
                keepRoleDecision = true;
            }
        }

        // A critically wounded non-tank should stop feeding the attacker.
        // Healers still get the first action slot for a self/party heal; once
        // no cast was started, every fragile role creates distance while
        // remaining attached to the party lifecycle.
        if (
            !acted &&
            partyThreat?.actor &&
            role !== 'tank' &&
            botVitals.hpRatio < CRITICAL_COMBAT_HP_RATIO &&
            !bot.state.fetchCasts()
        ) {
            const moved = retreatFromThreat(session, bot, partyThreat.actor, player, impairments.rooted);
            recordRoleDecision(session, bot, 'retreat', impairments.rooted ? 'critical_hp_rooted' : 'critical_hp_under_attack', {
                targetId: partyThreat.actor.fetchId(),
                hpRatio: botVitals.hpRatio,
                moved
            });
            return;
        }

        if (!acted && pulling.enabled && pulling.puller?.session === session && pulling.puller.kind === 'bot') {
            const pullAction = PartyPulling.tickBotPuller(session, bot, playerSession, partySettings, Generics, BotAI);
            pulling = PartyPulling.current(playerSession, partySettings);
            if (pullAction.handled) {
                const reason = pullAction.paused || pullAction.action || (pullAction.idle ? 'no_targets' : 'waiting');
                recordRoleDecision(session, bot, 'party_pull', reason, {
                    targetId: pullAction.target?.fetchId?.() || pulling.target?.fetchId?.() || null,
                    phase: pulling.phase || null
                });
                return;
            }
        }

        // Once the puller has returned to the formation, it can keep the
        // incoming mob occupied as soon as that mob reaches the puller's own
        // attack range. Do not wait for the stricter leader-centred camp
        // radius: it creates a visible idle window and can leave the tank
        // taking hits without responding.
        const pullerCanFightHeldTarget = !partyThreat &&
            pulling.enabled &&
            pulling.target &&
            pulling.puller?.kind === 'bot' &&
            pulling.puller?.session === session &&
            PartyPulling.actorCanEngage(bot, pulling.target);
        if (pullerCanFightHeldTarget) {
            partyThreat = {
                type: 'npc',
                actor: pulling.target,
                targetId: bot.fetchId(),
                source: 'party_pull_puller_range'
            };
        }

        const waitingForPullAtOwnRange = pulling.enabled && pulling.target && (
            pulling.puller?.session !== session && (
                !pulling.engageable || !PartyPulling.actorCanEngage(bot, pulling.target)
            )
        );
        if (!acted && waitingForPullAtOwnRange) {
            session.currentTargetId = undefined;
            bot.unselect();
            // The marked mob is intentionally not a chase target.  Keep the
            // formation on the player, then join combat once this particular
            // companion can strike from its own position.
            recordRoleDecision(session, bot, 'follow_leader', rawThreatOnlyTargetsTravellingPuller ? 'hold_for_pull' : (pulling.paused || 'hold_for_pull'), {
                targetId: pulling.target.fetchId(),
                pullerId: pulling.puller?.actor?.fetchId?.() || null
            });
            keepRoleDecision = true;
        }

        const activePartyThreats = partyThreat ? currentPartyAggroMonsters() : [];
        const protectedSession = partyThreat?.targetId
            ? PartyAwareness.partySessions(playerSession).find((memberSession) => (
                Number(memberSession.actor?.fetchId?.()) === Number(partyThreat.targetId)
            ))
            : null;
        const protectedRole = protectedSession === playerSession
            ? 'leader'
            : (protectedSession?.actor ? BotRoles.inferRole(protectedSession.actor) : null);

        if (!acted && partyThreat?.actor && !isBusy(bot)) {
            const selfTactic = PartyClassTactics.selfAction(bot, {
                role,
                activeMobs: activePartyThreats.length
            });
            if (selfTactic) {
                acted = true;
                recordRoleDecision(session, bot, 'class_tactic', selfTactic.reason, {
                    skillId: selfTactic.skill.fetchSelfId(),
                    activeMobs: activePartyThreats.length
                });
                castSkillOn(session, bot, Generics, selfTactic.target, selfTactic.skill, false);
            }
        }

        if (!acted && role === 'tank' && activePartyThreats.length >= 2 && !isBusy(bot)) {
            const massAggro = PartyClassTactics.tankMassAggroAction(bot, activePartyThreats);
            if (massAggro) {
                acted = true;
                recordRoleDecision(session, bot, 'protect_party', massAggro.reason, {
                    skillId: massAggro.skill.fetchSelfId(),
                    activeMobs: activePartyThreats.length
                });
                castSkillOn(session, bot, Generics, massAggro.target, massAggro.skill, true);
            }
        }

        if (!acted && role === 'tank') {
            const nearbyNpcs = World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), 800);
            const monsterToAggro = partyThreat?.type === 'npc'
                ? partyThreat.actor
                : nearbyNpcs.find((npc) => !BotRaidSafety.isProtectedRaidEntity(npc) && npc.fetchAttackable() && !npc.isDead() && partyActorIds(playerSession).has(npc.fetchDestId()));

            // Aggression is a transfer tool: use it only to take a mob away
            // from another party member. Once it is already attacking this
            // tank (including after a normal pull hit), continue normal combat
            // below instead of repeatedly taunting the same target.
            if (monsterToAggro && Number(monsterToAggro.fetchDestId?.()) !== Number(bot.fetchId())) {
                const skill = BotSkillCapabilities.aggressionSkill(bot);
                if (skill && bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot) && canAttemptAggression(session, monsterToAggro)) {
                    acted = true;
                    rememberAggressionAttempt(session, monsterToAggro);
                    recordRoleDecision(session, bot, 'protect_leader', 'leader_targeted', { targetId: monsterToAggro.fetchId() });
                    castSkillOn(session, bot, Generics, monsterToAggro, skill, true);
                } else if (!skill) {
                    recordRoleDecision(session, bot, 'cannot_taunt', 'no_learned_aggression');
                    keepRoleDecision = true;
                } else if (botVitals.mpRatio < 0.25) {
                    recordRoleDecision(session, bot, 'save_mp', 'low_mp_for_taunt');
                    keepRoleDecision = true;
                }
            }
        }

        if (!acted && role === 'tank' && activePartyThreats.length > 0 && !isBusy(bot)) {
            const stun = PartyClassTactics.tankStunAction(bot, activePartyThreats, { protectedRole });
            if (stun) {
                acted = true;
                recordRoleDecision(session, bot, 'protect_party', stun.reason, {
                    targetId: stun.target.fetchId(),
                    skillId: stun.skill.fetchSelfId()
                });
                castSkillOn(session, bot, Generics, stun.target, stun.skill, true);
            }
        }

        // Auto mode retains the lightweight tank fallback. Explicit Off is a
        // quiet order, not an "avoid overpull" failure that should overwrite
        // the tank's otherwise useful role status every tick.
        if (!acted && !partyRaid && role === 'tank' && partySettings.pullMode === 'auto') {
            const activeMobs = currentPartyAggroMonsters().length;
            const blockReason = PartyPulling.hasDeadPartyMember(playerSession)
                ? 'party_revival'
                : pullBlockReason(session, botVitals, partyVitals, activeMobs, partySettings);

            if (blockReason) {
                recordRoleDecision(session, bot, 'avoid_overpull', blockReason, { activeMobs });
                keepRoleDecision = true;
            } else {
                const nearbyNpcs = World.fetchNpcsInRadius(player.fetchLocX(), player.fetchLocY(), 900);
                let targetMonster = null;
                let closestDist = 900;

                for (const npc of nearbyNpcs) {
                    if (!BotRaidSafety.isProtectedRaidEntity(npc) && npc.fetchAttackable() && !npc.isDead() && npc.fetchDestId() === undefined) {
                        const distToBot = point(bot).distance(point(npc));
                        if (distToBot < closestDist) {
                            closestDist = distToBot;
                            targetMonster = npc;
                        }
                    }
                }

                if (targetMonster) {
                    if (!isBusy(bot)) {
                        acted = true;
                        recordRoleDecision(session, bot, 'pull_target', 'safe_pull', {
                            targetId: targetMonster.fetchId(),
                            activeMobs
                        });
                        BotAI.executeCombat(session, bot, targetMonster, Generics, { basicAttackOnly: true });
                    }
                }
            }
        }

        if (!acted && partyThreat?.actor && ['mage', 'healer', 'buffer'].includes(role) && !isBusy(bot)) {
            const crowdControl = PartyClassTactics.supportCrowdControl(bot, activePartyThreats, {
                primaryTargetId: pulling.target?.fetchId?.() || leaderTargetId
            });
            if (crowdControl) {
                acted = true;
                recordRoleDecision(session, bot, 'control_add', crowdControl.reason, {
                    targetId: crowdControl.target.fetchId(),
                    skillId: crowdControl.skill.fetchSelfId()
                });
                castSkillOn(session, bot, Generics, crowdControl.target, crowdControl.skill, true);
            }
        }

        if (!acted && partyThreat?.actor) {
            const target = partyThreat.actor;
            const targetId = target.fetchId();
            const holdSupportLine = !supportCanMeleeAssist(bot, role);
            if (holdSupportLine) {
                session.currentTargetId = undefined;
                bot.unselect();
                recordRoleDecision(session, bot, BotRoles.partyRoleStance(role), 'hold_support_line', {
                    targetId,
                    targetType: partyThreat.type,
                    protectedId: partyThreat.targetId,
                    threatSource: partyThreat.source || 'targeting_party'
                });
                keepRoleDecision = true;
            } else {
                // A combat-capable party member owns this tick even if an
                // earlier hit, cast, or approach is still in flight. Support
                // roles that hold their line may still follow the formation.
                acted = true;
            }

            if (!holdSupportLine && session.currentTargetId !== targetId) {
                if (bot.state?.fetchTowards?.() && !bot.state?.fetchHits?.() && !bot.state?.fetchCasts?.()) {
                    bot.automation?.abortAll?.(bot);
                }
                session.currentTargetId = targetId;
                bot.select({ id: targetId });
                recordRoleDecision(session, bot, assistActionForRole(role), 'party_under_attack', {
                    targetId,
                    targetType: partyThreat.type,
                    protectedId: partyThreat.targetId,
                    threatSource: partyThreat.source || 'targeting_party'
                });
            }

            if (!holdSupportLine && !isBusy(bot)) {
                const basicAttackOnly = role === 'healer' || role === 'buffer';
                if (partyThreat.type === 'player') {
                    BotAI.executePvPCombat(session, bot, target, Generics, { basicAttackOnly });
                } else {
                    BotAI.executeCombat(session, bot, target, Generics, {
                        basicAttackOnly,
                        playerPartyRaidLeaderSession: playerSession
                    });
                }
            }
        }

        if (!acted) {
            const playerTargetId = leaderTargetId;
            if (playerTargetId && playerTargetId !== bot.fetchId() && playerTargetId !== player.fetchId() && !supportCanMeleeAssist(bot, role)) {
                session.currentTargetId = undefined;
                bot.unselect();
                recordRoleDecision(session, bot, BotRoles.partyRoleStance(role), 'hold_support_line', { targetId: playerTargetId });
                keepRoleDecision = true;
            } else if (playerTargetId && playerTargetId !== bot.fetchId() && playerTargetId !== player.fetchId()) {
                acted = true;
                World.fetchUser(playerTargetId).then((user) => {
                    if (PartyAwareness.leaderCombatTargetId(playerSession, { allowPlayerRaid: true }) !== playerTargetId) return;
                    if (session.currentTargetId && session.currentTargetId !== playerTargetId) return;
                    const targetIsTeammate = user.session && (
                        user.session === playerSession ||
                        (user.session.followPlayerSession === playerSession && user.session.partyCompanion === true)
                    );

                    const isAttackablePvPTarget = user.fetchKarma() > 0 || user.fetchPvpFlag() > 0;

                    if (!user.state.fetchDead() && !targetIsTeammate && isAttackablePvPTarget) {
                        if (session.botStay && session.stayLocation) {
                            const stayDist = new SpeckMath.Point3D(session.stayLocation.locX, session.stayLocation.locY, session.stayLocation.locZ)
                                .distance(new SpeckMath.Point3D(user.fetchLocX(), user.fetchLocY(), user.fetchLocZ()));
                            if (stayDist > 900) {
                                recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                                return;
                            }
                        }

                        if (session.currentTargetId !== playerTargetId) {
                            session.currentTargetId = playerTargetId;
                            bot.select({ id: playerTargetId });
                            recordRoleDecision(session, bot, assistActionForRole(role), 'pvp_target', { targetId: playerTargetId });
                        }
                        if (isBusy(bot) || !supportCanMeleeAssist(bot, role)) {
                            return;
                        }
                        BotAI.executePvPCombat(session, bot, user, Generics, {
                            basicAttackOnly: role === 'healer' || role === 'buffer'
                        });
                    } else {
                        if (session.currentTargetId === playerTargetId) {
                            session.currentTargetId = undefined;
                            bot.unselect();
                        }
                    }
                }).catch(() => {
                    World.fetchNpc(playerTargetId).then((npc) => {
                        if (PartyAwareness.leaderCombatTargetId(playerSession, { allowPlayerRaid: true }) !== playerTargetId) return;
                        if (session.currentTargetId && session.currentTargetId !== playerTargetId) return;
                        if ((!BotRaidSafety.isProtectedRaidEntity(npc) || BotRaidSafety.canEngagePlayerPartyRaid(session, npc, playerSession)) && npc.fetchAttackable() && !npc.isDead()) {
                            if (session.botStay && session.stayLocation) {
                                const stayDist = new SpeckMath.Point3D(session.stayLocation.locX, session.stayLocation.locY, session.stayLocation.locZ)
                                    .distance(new SpeckMath.Point3D(npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()));
                                if (stayDist > 900) {
                                    recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                                    return;
                                }
                            }

                            if (session.currentTargetId !== playerTargetId) {
                                session.currentTargetId = playerTargetId;
                                bot.select({ id: playerTargetId });
                                recordRoleDecision(session, bot, assistActionForRole(role), assistReasonForRole(role), { targetId: playerTargetId });
                            }
                            if (isBusy(bot) || !supportCanMeleeAssist(bot, role)) {
                                return;
                            }
                            BotAI.executeCombat(session, bot, npc, Generics, {
                                basicAttackOnly: role === 'healer' || role === 'buffer',
                                playerPartyRaidLeaderSession: playerSession
                            });
                        } else {
                            if (session.currentTargetId === playerTargetId) {
                                session.currentTargetId = undefined;
                                bot.unselect();
                            }
                        }
                    }).catch(() => {
                        if (session.currentTargetId === playerTargetId) {
                            session.currentTargetId = undefined;
                            bot.unselect();
                        }
                    });
                });
            } else {
                session.currentTargetId = undefined;
                bot.unselect();
            }
        }

        if (!session.currentTargetId && !acted) {
            if (session.botStay && session.stayLocation) {
                session.lastFollowMoveTarget = null;
                const stayDist = point(bot).distance(new SpeckMath.Point3D(
                    session.stayLocation.locX,
                    session.stayLocation.locY,
                    session.stayLocation.locZ
                ));
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                }
                if (stayDist > 100) {
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: session.stayLocation.locX, locY: session.stayLocation.locY, locZ: session.stayLocation.locZ }
                    });
                }
            } else if (distance > FOLLOW_RUN_DISTANCE || PartyCompanionService.regroupActive(playerSession)) {
                if (impairments.rooted) {
                    recordRoleDecision(session, bot, 'hold_position', 'rooted');
                    return;
                }
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, 'follow_leader', 'keep_range');
                }
                const followTarget = followTargetFor(session, player);
                if (distance2d(loc(bot), followTarget) <= FOLLOW_FORMATION_TOLERANCE) {
                    session.lastFollowMoveTarget = null;
                } else {
                    if (shouldKeepCurrentFollowMove(session, bot, player, distance)) {
                        session.lastFollowMoveHeldAt = Date.now();
                        return;
                    }
                    moveToFollowTarget(session, bot, player);
                }
            } else {
                session.lastFollowMoveTarget = null;
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, BotRoles.partyRoleStance(role), 'ready');
                }
            }
        }
    }
};
