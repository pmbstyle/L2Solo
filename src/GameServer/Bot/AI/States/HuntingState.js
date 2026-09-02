const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const SpotService    = invoke('GameServer/Bot/AI/SpotService');
const DecisionService = invoke('GameServer/Bot/AI/BotDecisionService');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const BotTargetScorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const BotPvpRisk      = invoke('GameServer/Bot/AI/BotPvpRisk');
const BotRoles        = invoke('GameServer/Bot/AI/BotRoles');
const SummonerTactics = invoke('GameServer/Bot/AI/SummonerTactics');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const BotTownTravel  = invoke('GameServer/Bot/AI/BotTownTravel');
const BotSpotTravel  = invoke('GameServer/Bot/AI/BotSpotTravel');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const BotRaidSafety   = invoke('GameServer/Bot/AI/BotRaidSafety');
const HotActorLodPolicy = invoke('GameServer/Bot/AI/HotActorLodPolicy');
const BotRangedCombatPositioning = invoke('GameServer/Bot/AI/BotRangedCombatPositioning');
const BotHuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const HotTownRebuff = invoke('GameServer/Bot/AI/HotTownRebuff');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const BotHuntingGroundPolicy = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');

const TARGET_STALL_TICKS = 5;
const TARGET_RETRY_COOLDOWN_MS = 15000;
const TARGET_PROGRESS_DISTANCE = 40;
const TARGET_SPOT_GRID_SIZE = 6000;
const TARGET_GEODATA_CHECK_LIMIT = 4;
const EMERGENCY_RETREAT_HP_RATIO = 0.35;
const EMERGENCY_RETREAT_MP_RATIO = 0.20;
const EMERGENCY_RETREAT_DISTANCE = 850;
const MAX_WALK_SPOT_DISTANCE = 12000;
const SPOT_ARRIVAL_RADIUS = 1000;
const MAX_SPOT_RELOCATION_MS = 120000;
const FULL_TARGET_CANDIDATE_LIMIT = 96;
const VISIBLE_TARGET_CANDIDATE_LIMIT = 32;
const ENCOUNTER_BASE_HP_RATIO = 0.70;
const ENCOUNTER_BASE_MP_RATIO = 0.45;

function isSoloHunter(session) {
    return session.plan === 'hunting' && session.partyCompanion !== true && !session.followPlayerSession;
}

function isPartyCompanion(session) {
    return session.partyCompanion === true && !!session.followPlayerSession;
}

function isClaimedByOtherSoloBot(session, npc) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const npcId = npc.fetchId();

    return BotManager.sessions.some((otherSession) => {
        if (otherSession === session || !otherSession.actor || !isSoloHunter(otherSession)) return false;
        if (otherSession.currentTargetId !== npcId) return false;
        return !otherSession.actor.state.fetchDead();
    });
}

function startShopping(session, bot, BotAI, reason) {
    if (isPartyCompanion(session)) {
        session.plan = 'following';
        session.shoppingTarget = undefined;
        session.shoppingDoneAnnounced = false;
        TownChatter.say(session, BotAI, 'shopping-deferred', [
            'Staying with the party. I can sell the loot later.',
            "The bag can wait; I'm not leaving the group for shopping.",
            'Skipping the town run for now and keeping up with the party.',
            "I'll handle the loot on our next town stop."
        ]);
        return false;
    }

    return BotTownTravel.request(session, bot, BotAI, reason);
}

function claimedTargetIds(session, sessions = invoke('GameServer/Bot/BotManager').sessions || []) {
    const claimed = new Set();
    sessions.forEach((otherSession) => {
        if (otherSession === session || !otherSession.actor || !isSoloHunter(otherSession)) return;
        if (!otherSession.currentTargetId || otherSession.actor.state.fetchDead()) return;
        claimed.add(Number(otherSession.currentTargetId));
    });
    return claimed;
}

function limitTargetCandidates(session, bot, candidates) {
    const limit = session.hotActorLod?.tier === 'visible'
        ? VISIBLE_TARGET_CANDIDATE_LIMIT
        : FULL_TARGET_CANDIDATE_LIMIT;
    if (candidates.length <= limit) return candidates;
    return candidates
        .map((npc) => ({ npc, distance: targetDistance(bot, npc) }))
        .sort((first, second) => first.distance - second.distance)
        .slice(0, limit)
        .map((entry) => entry.npc);
}

function findPreferredMonster(session, bot, radius, options = {}) {
    const scanStartedAt = Date.now();
    const allNearbyNpcs = World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), radius);
    // Far-visible actors still choose a plausible nearby target, but do not
    // multiply the expensive claim scan by every NPC in a dense spawn cell.
    const eligibleNearbyNpcs = allNearbyNpcs
        .filter((npc) => !options.excludeTargetId || npc.fetchId() !== options.excludeTargetId)
        .filter((npc) => !BotRaidSafety.isProtectedRaidEntity(npc))
        .filter((npc) => BotHuntingTargetPolicy.canHunt(npc))
        .filter((npc) => npc.fetchAttackable() && !npc.isDead());
    const nearbyNpcs = limitTargetCandidates(session, bot, eligibleNearbyNpcs);
    const claimedIds = claimedTargetIds(session);
    const clanCounts = nearbyNpcs.reduce((counts, npc) => {
        const clan = npc.fetchClanName?.();
        if (clan) counts.set(clan, (counts.get(clan) || 0) + 1);
        return counts;
    }, new Map());
    const spotIdAt = (actor) => `${Math.floor(actor.fetchLocX() / TARGET_SPOT_GRID_SIZE)}_${Math.floor(actor.fetchLocY() / TARGET_SPOT_GRID_SIZE)}`;
    const currentSpotId = String(session.currentSpot?.id || spotIdAt(bot)).split(':')[0];
    // Actor totals are invariant for this target scan. Compute them once;
    // candidate NPCs use their cheap base stats to keep dense cells bounded.
    const botCombatStats = {
        pAtk: bot.fetchCollectivePAtk?.(),
        mAtk: bot.fetchCollectiveMAtk?.(),
        pDef: bot.fetchCollectivePDef?.(),
        maxHp: bot.fetchMaxHp?.()
    };

    const candidates = nearbyNpcs
        .map((npc) => {
            const claimed = claimedIds.has(Number(npc.fetchId()));
            const npcSpotId = spotIdAt(npc);
            const clan = npc.fetchClanName?.();
            const scoreContext = {
                attackable: npc.fetchAttackable(),
                raidEntity: BotRaidSafety.isProtectedRaidEntity(npc),
                dead: npc.isDead(),
                retryCooldown: targetOnCooldown(session, npc.fetchId()),
                botLevel: bot.fetchLevel(),
                npcLevel: npc.fetchLevel?.() || bot.fetchLevel(),
                distance: targetDistance(bot, npc),
                verticalGap: Math.abs(bot.fetchLocZ() - npc.fetchLocZ()),
                currentSpotId,
                npcSpotId,
                claimed,
                socialAllies: clan ? Math.max(0, (clanCounts.get(clan) || 1) - 1) : 0,
                solo: isSoloHunter(session),
                botPAtk: botCombatStats.pAtk,
                botMAtk: botCombatStats.mAtk,
                botPDef: botCombatStats.pDef,
                botMaxHp: botCombatStats.maxHp,
                npcPAtk: npc.fetchPAtk?.() ?? npc.fetchCollectivePAtk?.(),
                npcPDef: npc.fetchPDef?.() ?? npc.fetchCollectivePDef?.(),
                npcMDef: npc.fetchMDef?.() ?? npc.fetchCollectiveMDef?.(),
                npcMaxHp: npc.fetchMaxHp?.()
            };
            return {
                npc,
                evaluation: BotTargetScorer.score(scoreContext),
                readiness: options.readyOnly ? encounterReadiness(bot, npc) : null,
                scoreContext,
                claimed
            };
        })
        .filter((candidate) => !options.freeOnly || !candidate.claimed);

    const preRanked = BotTargetScorer.rank(candidates);
    const checkedIds = new Set(preRanked
        .slice(0, TARGET_GEODATA_CHECK_LIMIT)
        .map((candidate) => candidate.npc.fetchId()));
    const ranked = BotTargetScorer.rank(candidates.map((candidate) => {
        if (!checkedIds.has(candidate.npc.fetchId())) return candidate;
        const directPath = GeodataEngine.hasLineOfSight(
            bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ(),
            candidate.npc.fetchLocX(), candidate.npc.fetchLocY(), candidate.npc.fetchLocZ()
        );
        return {
            ...candidate,
            evaluation: BotTargetScorer.score({ ...candidate.scoreContext, directPath })
        };
    }));

    const selected = (options.readyOnly
        ? ranked.find((candidate) => candidate.readiness.ready)
        : ranked[0]) || null;
    const readinessCandidate = options.readyOnly ? (selected || ranked[0] || null) : null;
    session.lastEncounterReadiness = readinessCandidate ? {
        ...readinessCandidate.readiness,
        targetId: readinessCandidate.npc.fetchId(),
        at: Date.now()
    } : undefined;
    session.lastTargetEvaluation = selected ? {
        targetId: selected.npc.fetchId(),
        targetName: selected.npc.fetchName(),
        score: selected.evaluation.score,
        reasons: selected.evaluation.reasons,
        at: Date.now()
    } : null;
    HotActorLodPolicy.recordSubsystem('targetScan', Date.now() - scanStartedAt, nearbyNpcs.length);
    return selected?.npc || null;
}

function targetDistance(bot, target) {
    return new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
        .distance(new SpeckMath.Point3D(target.fetchLocX(), target.fetchLocY(), target.fetchLocZ()));
}

function liveCurrentNpcTarget(session, bot, radius = 2500) {
    const targetId = Number(session.currentTargetId || 0);
    if (!targetId) return null;

    const target = (World.npc?.spawns || []).find((npc) => Number(npc.fetchId?.() || 0) === targetId);
    if (!target || target.fetchAttackable?.() !== true || target.isDead?.() === true || target.state?.fetchDead?.() === true) {
        return null;
    }
    return targetDistance(bot, target) <= radius ? target : null;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function encounterReadiness(bot, target) {
    const hpRatio = bot.fetchHp() / Math.max(1, bot.fetchMaxHp());
    const mpRatio = bot.fetchMp() / Math.max(1, bot.fetchMaxMp());
    const levelGap = Number(target?.fetchLevel?.() || bot.fetchLevel()) - Number(bot.fetchLevel());
    const targetHpRatio = clamp(
        Number(target?.fetchHp?.() ?? target?.fetchMaxHp?.() ?? 1) /
            Math.max(1, Number(target?.fetchMaxHp?.() ?? target?.fetchHp?.() ?? 1)),
        0,
        1
    );
    const fullTargetHpNeed = clamp(
        ENCOUNTER_BASE_HP_RATIO + (Math.max(0, levelGap) * 0.04) + (Math.min(0, levelGap) * 0.025),
        0.55,
        0.90
    );
    const hpNeeded = clamp(0.40 + ((fullTargetHpNeed - 0.40) * targetHpRatio), 0.40, 0.90);
    const manaDependent = BotRoles.shouldRestForMana(bot);
    const fullTargetMpNeed = clamp(
        ENCOUNTER_BASE_MP_RATIO + (Math.max(0, levelGap) * 0.03),
        0.35,
        0.70
    );
    const mpNeeded = manaDependent
        ? clamp(0.20 + ((fullTargetMpNeed - 0.20) * targetHpRatio), 0.20, 0.70)
        : 0;
    const ready = hpRatio >= hpNeeded && (!manaDependent || mpRatio >= mpNeeded);

    return {
        ready,
        reason: hpRatio < hpNeeded ? 'hp_reserve' : (!ready ? 'mp_reserve' : 'ready'),
        hpRatio,
        hpNeeded,
        mpRatio,
        mpNeeded,
        targetHpRatio,
        levelGap
    };
}

function rememberEncounterReadiness(session, target, readiness) {
    session.lastEncounterReadiness = {
        ...readiness,
        targetId: target?.fetchId?.() || null,
        at: Date.now()
    };
}

function beginVoluntaryRecovery(session, bot, BotAI, readiness = null) {
    if (session.currentTargetId) clearTarget(session, bot, session.currentTargetId);
    session.lastTargetEvaluation = undefined;
    session.lastCombatDecision = undefined;
    session.lastPvpDecision = undefined;
    session.plan = 'resting';
    session.recoveryLocked = true;
    if (!bot.state.fetchSeated()) {
        bot.state.setSeated(true);
        session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    }
    session.lastDecision = {
        action: 'recover_before_encounter',
        reason: readiness?.reason || 'low_resources',
        hpRatio: readiness?.hpRatio ?? (bot.fetchHp() / Math.max(1, bot.fetchMaxHp())),
        hpNeeded: readiness?.hpNeeded ?? EMERGENCY_RETREAT_HP_RATIO,
        mpRatio: readiness?.mpRatio ?? (bot.fetchMp() / Math.max(1, bot.fetchMaxMp())),
        mpNeeded: readiness?.mpNeeded ?? EMERGENCY_RETREAT_MP_RATIO,
        at: Date.now()
    };
    BotAI.say(session, "Phew! My HP/MP is low. Sitting down to recover.");
}

function targetOnCooldown(session, targetId) {
    const until = Number(session.targetRetryAfter?.[targetId] || 0);
    if (!until) return false;
    if (Date.now() < until) return true;
    delete session.targetRetryAfter[targetId];
    return false;
}

function botLocation(bot) {
    return { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
}

function currentHuntingGround(session, bot) {
    try {
        const physical = SpotService.findCurrentSpot(botLocation(bot));
        if (physical) return physical;
        if (session.currentSpot?.id) return SpotService.findById(session.currentSpot.id) || session.currentSpot;
        return session.currentSpot || null;
    } catch (_) {
        return session.currentSpot || null;
    }
}

function equippedItems(bot) {
    return bot.backpack?.fetchItems?.() || [];
}

function finishWalkRelocation(session, bot, spot) {
    const arrivedSpot = SpotService.findById(spot.id) || spot;
    SpotService.assignSpot(session, arrivedSpot);
    session.initialSpawnCoord = { ...arrivedSpot.center };
    session.spotRelocation = undefined;
    session.townRoutePlan = null;
    session.lastSpotRelocation = { spotId: arrivedSpot.id, method: 'walk', at: Date.now() };
}

function expireSpotRelocation(session, bot, relocation) {
    session.spotRelocation = undefined;
    bot?.state?.setCasts?.(false);
    TownNpcApproach.reset(session);
    session.lastSpotRelocation = {
        spotId: relocation.spotId,
        method: `${relocation.method || 'walk'}_timeout`,
        at: Date.now()
    };
}

function expireTimedOutSpotRelocation(session, bot) {
    const relocation = session.spotRelocation;
    if (!relocation) return false;
    const startedAt = Number(relocation.startedAt);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < MAX_SPOT_RELOCATION_MS) return false;
    expireSpotRelocation(session, bot, relocation);
    return true;
}

function issueWalkRelocation(session, bot, relocation) {
    const from = botLocation(bot);
    relocation.lastCommandAt = Date.now();
    bot.moveTo({ from, to: { ...relocation.destination } });
}

function tickSpotRelocation(session, bot) {
    const relocation = session.spotRelocation;
    if (!relocation) return false;
    if (expireTimedOutSpotRelocation(session, bot)) return false;
    if (relocation.method === 'town_gatekeeper') return BotSpotTravel.tick(session, bot);
    if (relocation.method === 'soe_gatekeeper') return true;

    const distance = SpotService.distance2d(botLocation(bot), relocation.destination);
    if (distance <= SPOT_ARRIVAL_RADIUS) {
        finishWalkRelocation(session, bot, SpotService.findById(relocation.spotId) || { id: relocation.spotId, center: relocation.destination });
        return false;
    }
    if (bot.state.fetchTowards() || session.moveTimer) return true;
    if (Date.now() - Number(relocation.lastCommandAt || 0) >= 1000) issueWalkRelocation(session, bot, relocation);
    return true;
}

function beginSpotRelocation(session, bot, spot, BotAI) {
    const destination = { ...spot.center };
    session.currentTargetId = undefined;
    bot.unselect?.();
    session.noTargetTicks = 0;
    session.lastSpotMoveAt = Date.now();

    const finishedTownErrands = session.pendingFarmDepartureAnnouncement === true;
    delete session.pendingFarmDepartureAnnouncement;
    const destinationName = SpotService.describe(spot);
    TownChatter.say(session, BotAI, finishedTownErrands ? 'town-to-farm' : 'farm-relocation', finishedTownErrands
        ? [
            `Town business finished. Heading to ${destinationName} to farm.`,
            `Supplies sorted — next stop is ${destinationName}.`,
            `Done in town. Moving out toward ${destinationName}.`,
            `Errands complete; time to hunt around ${destinationName}.`,
            `Everything is ready. Leaving for ${destinationName}.`,
            `Town stop complete. Back to farming at ${destinationName}.`
        ]
        : [
            `Heading to ${destinationName} to farm.`,
            `Moving on to ${destinationName} for the next hunt.`,
            `The next farming route is around ${destinationName}.`,
            `Setting out for ${destinationName}.`,
            `I will look for targets near ${destinationName}.`,
            `Changing hunting grounds to ${destinationName}.`
        ]);

    const travelDistance = SpotService.distance2d(botLocation(bot), destination);
    if (travelDistance > MAX_WALK_SPOT_DISTANCE) {
        const departureTown = finishedTownErrands
            ? BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
            : null;
        if (!departureTown || !BotSpotTravel.startViaTownGatekeeper(
            session,
            bot,
            spot,
            destination,
            { townName: departureTown.name }
        )) {
            BotSpotTravel.start(session, bot, spot, destination);
        }
        return;
    }

    // A nearby farming destination is reached on foot. TownPathfinder chooses
    // the measured physical gate whose exit points most directly at the spot.
    session.spotRelocation = {
        mode: 'walk',
        method: 'walk',
        spotId: spot.id,
        destination,
        startedAt: Date.now(),
        lastCommandAt: 0
    };
    issueWalkRelocation(session, bot, session.spotRelocation);
}

function reconcilePhysicalSpot(session, bot) {
    if (session.spotRelocation) return;
    const physical = SpotService.findCurrentSpot(botLocation(bot));
    if (physical && session.currentSpot?.id !== physical.id) SpotService.assignSpot(session, physical);
}

function assignTarget(session, bot, target) {
    const targetId = target.fetchId();
    if (session.currentTargetId !== targetId) {
        session.targetTrackId = targetId;
        session.targetAcquiredAt = Date.now();
        session.targetLastDistance = targetDistance(bot, target);
        session.targetStallTicks = 0;
    }
    session.currentTargetId = targetId;
    bot.select({ id: targetId });
}

function clearTarget(session, bot, targetId, retryCooldown = false) {
    if (session.currentTargetId !== targetId) return false;
    if (retryCooldown) {
        session.targetRetryAfter = session.targetRetryAfter || {};
        session.targetRetryAfter[targetId] = Date.now() + TARGET_RETRY_COOLDOWN_MS;
    }
    session.currentTargetId = undefined;
    session.targetTrackId = undefined;
    session.targetAcquiredAt = undefined;
    session.targetLastDistance = undefined;
    session.targetStallTicks = 0;
    bot.unselect();
    return true;
}

function needsEmergencyRetreat(bot) {
    return bot.fetchHp() / Math.max(1, bot.fetchMaxHp()) < EMERGENCY_RETREAT_HP_RATIO
        || bot.fetchMp() / Math.max(1, bot.fetchMaxMp()) < EMERGENCY_RETREAT_MP_RATIO;
}

function retreatFromThreat(session, bot, threat) {
    if (bot.state.fetchSeated()) {
        bot.state.setSeated(false);
        session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    }
    clearTarget(session, bot, session.currentTargetId);
    session.plan = 'fleeing';
    session.recoveryLocked = true;
    session.fleeStart = Date.now();
    session.incomingThreatId = undefined;
    session.incomingThreatAt = undefined;
    BotRetreatPlanner.retreat(session, bot, threat, { distance: EMERGENCY_RETREAT_DISTANCE });
}

function targetProgressing(session, bot, target) {
    const targetId = target.fetchId();
    const distance = targetDistance(bot, target);
    if (session.targetTrackId !== targetId) {
        session.targetTrackId = targetId;
        session.targetAcquiredAt = Date.now();
        session.targetLastDistance = distance;
        session.targetStallTicks = 0;
        return true;
    }

    const moving = bot.state.fetchTowards();
    const fighting = bot.state.fetchHits() || bot.state.fetchCasts() || distance <= 180;
    const movedCloser = Number(session.targetLastDistance || Infinity) - distance >= TARGET_PROGRESS_DISTANCE;
    session.targetLastDistance = distance;
    const shouldMeasureStall = moving || distance > 900;
    session.targetStallTicks = fighting || movedCloser || !shouldMeasureStall
        ? 0
        : (session.targetStallTicks || 0) + 1;
    return session.targetStallTicks < TARGET_STALL_TICKS;
}

module.exports = {
    limitTargetCandidates,
    claimedTargetIds,
    tick(session, bot, Generics, BotAI) {
        if (session.pendingTownTrip) {
            const trip = startShopping(session, bot, BotAI, session.pendingTownTrip.reason);
            if (trip !== 'deferred') return;
        }

        // 1. Expire buffs check for hunting bots. A hot bot already in a
        // starter town also refreshes once per visit before going back out.
        if (!session.followPlayerSession) {
            const townBuffVisit = HotTownRebuff.syncVisit(session, bot, BotAI);
            const townVisitNeedsRebuff = HotTownRebuff.needsVisit(session, townBuffVisit)
                && Number(session.newbieGuideRetryAt || 0) <= Date.now();
            if (townVisitNeedsRebuff || BotBuffs.needsNewbieRefresh(bot, 0)) {
                session.preBuffLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                session.preBuffPlan = 'hunting';
                session.resumeAfterBuff = townVisitNeedsRebuff
                    ? { plan: 'hunting', townVisitKey: townBuffVisit.key }
                    : undefined;
                session.plan = 'getting_buffed';
                session.currentTargetId = undefined;
                bot.automation.abortAll(bot);
                TownChatter.say(session, BotAI, 'heading-to-newbie-guide', townVisitNeedsRebuff
                    ? [
                        'Since I am in town, I will refresh my blessing before farming.',
                        'One quick Newbie Guide stop before I head back out.',
                        'I am already in town, so this is a good time to rebuff.',
                        'Refreshing my blessing now, then I am off to hunt.'
                    ]
                    : [
                        'My newbie blessings have expired. Heading to the guide.',
                        'Buffs are fading; I need a quick Newbie Guide visit.',
                        'Time to refresh my blessing before the next fight.',
                        'I am going to the Newbie Guide for a fresh set of buffs.'
                    ]);
                return;
            }
        }

        if (isSoloHunter(session) && ShotStock.needsActorRestock(bot, 0)) {
            const plan = ShotStock.planForActor(bot);
            const trip = startShopping(session, bot, BotAI, `Out of ${ShotStock.describe(plan)}. Heading to town to restock.`);
            if (trip !== 'deferred') return;
        }

        // 2. PK Spotting & Fleeing Check
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
        let spottedPk = null;
        let pkDistance = 99999;

        World.user.sessions.forEach((user) => {
            const other = user.actor;
            if (other && other !== bot && other.fetchIsOnline() && !other.state.fetchDead() && other.fetchKarma() > 0) {
                const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                if (dist < 1500 && dist < pkDistance) {
                    pkDistance = dist;
                    spottedPk = other;
                }
            }
        });

        if (spottedPk) {
            const allies = World.user.sessions.filter((otherSession) => {
                const other = otherSession.actor;
                if (!BotPvpRisk.isCombatAlly(session, otherSession, spottedPk)) return false;
                const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                return dist < 1000;
            });
            const pvpDecision = BotPvpRisk.evaluate({
                botLevel: bot.fetchLevel(),
                threatLevel: spottedPk.fetchLevel(),
                hpRatio: bot.fetchHp() / Math.max(1, bot.fetchMaxHp()),
                mpRatio: bot.fetchMp() / Math.max(1, bot.fetchMaxMp()),
                allies: allies.length,
                targetedByThreat: spottedPk.fetchDestId?.() === bot.fetchId(),
                role: BotRoles.inferRole(bot)
            });
            session.lastPvpDecision = {
                ...pvpDecision,
                threatId: spottedPk.fetchId(),
                threatName: spottedPk.fetchName(),
                allies: allies.map((ally) => ally.actor.fetchId()),
                at: Date.now()
            };

            if (pvpDecision.action === 'fight') {
                if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'pk_combat');
                // Fight back!
                if (session.currentTargetId !== spottedPk.fetchId()) {
                    session.currentTargetId = spottedPk.fetchId();
                    bot.select({ id: spottedPk.fetchId() });
                    
                    if (Math.random() < 0.25) {
                        BotAI.say(session, `Everyone, attack the PK! Get ${spottedPk.fetchName()}!`);
                    }
                }
                if (!bot.state.fetchTowards() && !bot.state.fetchHits() && !bot.state.fetchCasts()) {
                    BotAI.executePvPCombat(session, bot, spottedPk, Generics);
                }
                return; // Skip rest of AI tick while fighting back PK!
            } else {
                if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'pk_flee');
                // Flee in panic!
                if (session.plan !== 'fleeing') {
                    session.plan = 'fleeing';
                    session.fleeStart = Date.now();
                    session.currentTargetId = undefined;
                    
                    const alarmPhrases = [
                        `Oh no! PK alert! ${spottedPk.fetchName()} is near! Run!`,
                        `Help! Red name ${spottedPk.fetchName()} is hunting here!`,
                        `PK! PK spotted! Flee for your lives!`,
                        `Ahhh! ${spottedPk.fetchName()} is going to PK us! Help!`
                    ];
                    BotAI.say(session, alarmPhrases[Math.floor(Math.random() * alarmPhrases.length)]);
                    
                    // Stand up if seated
                    if (bot.state.fetchSeated()) {
                        bot.state.setSeated(false);
                        session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
                    }

                    BotRetreatPlanner.retreat(session, bot, spottedPk, {
                        distance: EMERGENCY_RETREAT_DISTANCE
                    });
                }
                return; // Skip rest of AI tick while fleeing!
            }
        }

        // 3. Immediate self-defense outranks recovery. Sitting while a mob is
        // actively hitting the bot only turns the recovery state into a death loop.
        const incomingMonster = isSoloHunter(session)
            ? PartyAwareness.npcThreateningActor(session)
            : PartyAwareness.recentIncomingNpc(session);
        if (incomingMonster) {
            if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'incoming_threat');
            if (BotRaidSafety.retreat(session, bot, incomingMonster, { distance: EMERGENCY_RETREAT_DISTANCE })) {
                return;
            }
            const currentGround = currentHuntingGround(session, bot);
            const groundSafety = currentGround
                ? BotHuntingGroundPolicy.evaluate(currentGround, { level: bot.fetchLevel() }, {
                    mode: 'solo',
                    equipment: equippedItems(bot)
                })
                : { allowed: true };
            if (!groundSafety.allowed || needsEmergencyRetreat(bot)) {
                retreatFromThreat(session, bot, incomingMonster);
                return;
            }
            assignTarget(session, bot, incomingMonster);
            if (bot.state.fetchSeated()) {
                bot.state.setSeated(false);
                session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
            }
            if (BotRangedCombatPositioning.reposition(session, bot, incomingMonster)) return;
            if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) return;
            BotAI.executeCombat(session, bot, incomingMonster, Generics);
            return;
        }

        // Expire a stuck walk/SoE transition even when the bot is too weak to
        // leave its recovery state yet. The movement gate below still yields
        // to HP/MP recovery for live relocations.
        expireTimedOutSpotRelocation(session, bot);

        // 4. HP/MP resting check
        const hpRatio = bot.fetchHp() / bot.fetchMaxHp();
        const mpRatio = bot.fetchMp() / bot.fetchMaxMp();
        const liveEncounterTarget = liveCurrentNpcTarget(session, bot);
        const nativeCombatActionInFlight = !!session.currentTargetId && (
            bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()
        );
        const encounterActionInFlight = !!liveEncounterTarget || nativeCombatActionInFlight;
        // Native attack/cast flags briefly drop between individual swings.
        // A live selected NPC still owns the encounter during that gap, so a
        // critically wounded bot must retreat instead of clearing the target
        // and sitting down in front of it.
        if (liveEncounterTarget && !nativeCombatActionInFlight && needsEmergencyRetreat(bot)) {
            if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'low_resources_in_combat');
            if (BotRaidSafety.retreat(session, bot, liveEncounterTarget, { distance: EMERGENCY_RETREAT_DISTANCE })) {
                return;
            }
            retreatFromThreat(session, bot, liveEncounterTarget);
            return;
        }
        // Match RestingState's role-aware wake policy.  Melee/dps bots are
        // allowed to keep hunting with low MP; otherwise they immediately
        // wake again at full HP and oscillate between hunting and resting.
        if (!encounterActionInFlight && (
            hpRatio < 0.35 || (BotRoles.shouldRestForMana(bot) && mpRatio < 0.20)
        )) {
            beginVoluntaryRecovery(session, bot, BotAI);
            return;
        }

        // A hunting-ground relocation owns the movement/combat window. Do not
        // attack starter mobs while walking or casting SoE to a better field.
        // Recovery above intentionally wins so a bot cannot walk while dying.
        if (tickSpotRelocation(session, bot)) return;

        if (isSoloHunter(session)) {
            const currentGround = currentHuntingGround(session, bot);
            const groundSafety = currentGround
                ? BotHuntingGroundPolicy.evaluate(currentGround, { level: bot.fetchLevel() }, {
                    mode: 'solo',
                    equipment: equippedItems(bot)
                })
                : { allowed: true };
            if (!groundSafety.allowed) {
                if (session.currentTargetId) clearTarget(session, bot, session.currentTargetId);
                const status = session.botStatus || BotAI.getStatus(session);
                const destination = SpotService.findBestSpot(status, {
                    minDistance: 1,
                    mode: 'solo',
                    equipment: equippedItems(bot)
                });
                session.lastDecision = {
                    action: destination?.spot ? 'move_to_spot' : 'avoid_hunting_ground',
                    reason: groundSafety.reason,
                    spotId: destination?.spot?.id || currentGround.id,
                    spotName: destination?.spot?.name || currentGround.name
                };
                if (destination?.spot) beginSpotRelocation(session, bot, destination.spot, BotAI);
                return;
            }
        }

        if (isSoloHunter(session) && Math.random() < 0.005) { // ~0.5% chance per tick (~10 minutes)
            const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
            const trip = startShopping(session, bot, BotAI, `My bags are full of loot. Heading to ${closestTown.name} to sell and restock.`);
            if (trip !== 'deferred') return;
        }

        // 5. Hunt/Attack Combat execution
        if (session.currentTargetId) {
            const targetId = session.currentTargetId;
            World.fetchUser(targetId).then((targetActor) => {
                if (session.currentTargetId !== targetId) return;
                if (targetActor && targetActor.fetchIsOnline() && !targetActor.state.fetchDead()) {
                    if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) {
                        return;
                    }
                    BotAI.executePvPCombat(session, bot, targetActor, Generics);
                } else {
                    clearTarget(session, bot, targetId);
                }
            }).catch(() => {
                World.fetchNpc(targetId).then((npc) => {
                    if (session.currentTargetId !== targetId) return;
                    if (BotRaidSafety.isProtectedRaidEntity(npc)) {
                        clearTarget(session, bot, targetId);
                        session.lastDecision = {
                            action: 'abandon_target',
                            reason: 'raid_entity_protected',
                            targetId,
                            at: Date.now()
                        };
                    } else if (npc.isDead()) {
                        const corpseSkill = SummonerTactics.corpseSummonSkill(bot, npc);
                        if (corpseSkill) {
                            BotAI.executeCombat(session, bot, npc, Generics);
                            return;
                        }
                        if (Math.random() < 0.20) {
                            BotAI.say(session, BotAI.getRandomPhrase('victory'));
                        }
                        clearTarget(session, bot, targetId);
                    } else {
                        const npcAggroedOnBot = Number(npc.fetchDestId?.() || 0) === Number(bot.fetchId());
                        if (isSoloHunter(session) && !npcAggroedOnBot &&
                            !bot.state.fetchTowards() && !bot.state.fetchHits() && !bot.state.fetchCasts()) {
                            const readiness = encounterReadiness(bot, npc);
                            rememberEncounterReadiness(session, npc, readiness);
                            if (!readiness.ready) {
                                beginVoluntaryRecovery(session, bot, BotAI, readiness);
                                return;
                            }
                        }
                        if (!targetProgressing(session, bot, npc)) {
                            clearTarget(session, bot, targetId, true);
                            session.lastDecision = {
                                action: 'abandon_target',
                                reason: 'no_progress',
                                targetId,
                                retryAfter: session.targetRetryAfter?.[targetId] || null
                            };
                            return;
                        }
                        if (BotRangedCombatPositioning.reposition(session, bot, npc)) return;
                        if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) {
                            return;
                        }

                        if (isClaimedByOtherSoloBot(session, npc)) {
                            const alternateMonster = findPreferredMonster(session, bot, 2500, {
                                excludeTargetId: npc.fetchId(),
                                freeOnly: true
                            });
                            if (alternateMonster) {
                                assignTarget(session, bot, alternateMonster);
                                BotAI.executeCombat(session, bot, alternateMonster, Generics);
                                return;
                            }
                        }

                        BotAI.executeCombat(session, bot, npc, Generics);
                    }
                }).catch(() => {
                    clearTarget(session, bot, targetId);
                });
            });
        } else {
            reconcilePhysicalSpot(session, bot);
            // Prefer unclaimed mobs so solo bots do not form accidental trains.
            const closestMonster = findPreferredMonster(session, bot, 2500, {
                readyOnly: isSoloHunter(session)
            });

            if (closestMonster) {
                session.noTargetTicks = 0;
                assignTarget(session, bot, closestMonster);

                if (!session.currentSpot) {
                    const spot = SpotService.findCurrentSpot({
                        locX: bot.fetchLocX(),
                        locY: bot.fetchLocY(),
                        locZ: bot.fetchLocZ()
                    });
                    SpotService.assignSpot(session, spot);
                }

                if (Math.random() < 0.15) {
                    BotAI.say(session, BotAI.getRandomPhrase('foundTarget', closestMonster.fetchName()));
                }
                BotAI.executeCombat(session, bot, closestMonster, Generics);
            } else {
                if (isSoloHunter(session) && session.lastEncounterReadiness?.ready === false) {
                    beginVoluntaryRecovery(session, bot, BotAI, session.lastEncounterReadiness);
                    return;
                }
                session.noTargetTicks = (session.noTargetTicks || 0) + 1;

                if (isPartyCompanion(session)) {
                    session.plan = 'following';
                    session.noTargetTicks = 0;
                    session.lastDecision = {
                        action: 'follow_leader',
                        reason: 'party_hunt_no_targets',
                        spotId: session.currentSpot?.id || null,
                        spotName: session.currentSpot?.name || null
                    };
                    return;
                }

                const currentSpot = SpotService.findCurrentSpot({
                    locX: bot.fetchLocX(),
                    locY: bot.fetchLocY(),
                    locZ: bot.fetchLocZ()
                });
                if (!session.currentSpot && currentSpot) {
                    SpotService.assignSpot(session, currentSpot);
                }

                const decision = DecisionService.suggest(session.botStatus || BotAI.getStatus(session), session);
                session.lastDecision = {
                    action: decision.action,
                    reason: decision.reason,
                    spotId: decision.spot?.id || null,
                    spotName: decision.spot?.name || null
                };

                if (decision.action === 'move_to_spot' && decision.spot) {
                    beginSpotRelocation(session, bot, decision.spot, BotAI);
                    return;
                }

                // Wandering to search for monsters in starting zones if none nearby
                if (Math.random() < 0.50) {
                    if (!session.initialSpawnCoord) {
                        session.initialSpawnCoord = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                    }
                    const baseCoord = session.initialSpawnCoord;
                    
                    // Wander up to 2500 units away from their initial spawn coordinate to hunt!
                    const wanderX = baseCoord.locX + utils.oneFromSpan(-2500, 2500);
                    const wanderY = baseCoord.locY + utils.oneFromSpan(-2500, 2500);
                    
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: wanderX, locY: wanderY, locZ: bot.fetchLocZ() }
                    });
                }
            }
        }
    }
};
