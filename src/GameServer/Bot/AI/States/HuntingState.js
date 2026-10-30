const ActorQueries = require('../../../World/ActorSpatialQueries');
const refreshPartyMemberships = require('../../../World/PartyMembershipPublication');
const NpcObjectIndex = require('../../../World/NpcObjectIndex');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const SpotService    = invoke('GameServer/Bot/AI/SpotService');
const Karma          = invoke('GameServer/Karma');
const DecisionService = invoke('GameServer/Bot/AI/BotDecisionService');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const BotTargetScorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const EncounterReadiness = invoke('GameServer/Bot/AI/BotEncounterReadiness');
const BotPvpRisk      = invoke('GameServer/Bot/AI/BotPvpRisk');
const BotRoles        = invoke('GameServer/Bot/AI/BotRoles');
const RestPolicy      = invoke('GameServer/Bot/AI/RestPolicy');
const SoloSelfHeal = invoke('GameServer/Bot/AI/SoloSelfHeal');
const DangerMoment    = invoke('GameServer/Bot/AI/DangerMoment');
const SummonerTactics = invoke('GameServer/Bot/AI/SummonerTactics');
const BotTownTravel  = invoke('GameServer/Bot/AI/BotTownTravel');
const BotSpotTravel  = invoke('GameServer/Bot/AI/BotSpotTravel');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const EscapePolicy = invoke('GameServer/Bot/AI/BotEscapePolicy');
const BotEmergencyFinisher = invoke('GameServer/Bot/AI/BotEmergencyFinisher');
const BotRaidSafety   = invoke('GameServer/Bot/AI/BotRaidSafety');
const HotActorLodPolicy = invoke('GameServer/Bot/AI/HotActorLodPolicy');
const BotRangedCombatPositioning = invoke('GameServer/Bot/AI/BotRangedCombatPositioning');
const BotHuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const BotPullEstimate = invoke('GameServer/Bot/AI/BotPullEstimate');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const HotTownRebuff = invoke('GameServer/Bot/AI/HotTownRebuff');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const BotHuntingGroundPolicy = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');
const HuntingVisibility = invoke('GameServer/Bot/AI/BotHuntingVisibility');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const SurvivalFloor = invoke('GameServer/Bot/Population/SurvivalFloor');
const DecisionEvents = require('../DecisionEvents');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const { SPOT_CELL_SIZE } = invoke('GameServer/World/WorldConstants');

const TARGET_STALL_TICKS = 5;
const TARGET_RETRY_COOLDOWN_MS = 15000;
const TARGET_PROGRESS_DISTANCE = 40;
const EMERGENCY_RETREAT_DISTANCE = 850;
const MAX_WALK_SPOT_DISTANCE = SpotService.MAX_WALK_SPOT_DISTANCE;
const SPOT_ARRIVAL_RADIUS = 1000;
const MAX_SPOT_RELOCATION_MS = 120000;
const FAILED_SPOT_RETRY_MS = 60000;
const FULL_TARGET_CANDIDATE_LIMIT = 96;
const VISIBLE_TARGET_CANDIDATE_LIMIT = 32;
const LOCAL_TARGET_SEARCH_RADIUS = 2500;
const SHOP_DEPARTURE_RADIUS = 900;

function leaveShop(session, bot, now = Date.now()) {
    if (!isSoloHunter(session) || !session.pendingFarmDepartureAnnouncement || session.spotRelocation
        || BotTownTravel.hasCombatThreat(session, bot) || bot.state?.fetchCasts?.()) return false;
    if (RestPolicy.needsRest(bot, bot.fetchHp?.() / bot.fetchMaxHp?.(), bot.fetchMp?.() / bot.fetchMaxMp?.())) return false;
    const point = botLocation(bot);
    const town = TownPathfinder.getTown(point);
    if (!town || SpotService.distance2d(point, town.center) <= SHOP_DEPARTURE_RADIUS) return false;
    if (Number(session.shopDepartureRetryAt || 0) > now) return true;
    // Choose a farming destination after clearing the shop, even when no
    // suitable hunt is available yet. Do not wander against the counter wall.
    const angle = Math.abs(Number(bot.fetchId()) % 16) * Math.PI / 8;
    const destination = {
        locX: Math.round(town.center.locX + Math.cos(angle) * 160),
        locY: Math.round(town.center.locY + Math.sin(angle) * 160),
        locZ: town.center.locZ,
        town: town.name
    };
    TownNpcApproach.reset(session);
    const navigation = CompanionNavigationRecovery.move(session, bot, destination, 'shop_departure',
        { targetActor: null, arrivalRadius: 160 });
    session.lastDecision = { action: 'leave_shop', reason: navigation.status, town: town.name, at: now };
    if (navigation.status === 'exhausted') {
        session.shopDepartureRetryAt = now + 5000;
        CompanionNavigationRecovery.clear(session);
    }
    return true;
}

function isSoloHunter(session) {
    return session.plan === 'hunting' && session.partyCompanion !== true && !session.followPlayerSession;
}

// When a solo hunter carries its bag to town: the cold rule
// (ItemDisposition.inventoryCleanupNeed) on the live bag. The verdict is kept
// until the bag, the life state, the level or the party changes, or the sell
// pause ends, so a tick with nothing new costs a few comparisons.
function sellTripDue(session, bot, now = Date.now()) {
    if (!isSoloHunter(session) || session.pendingTownTrip) return null;
    const items = bot.backpack?.fetchItems?.();
    if (!items) return null;
    const life = session.coldLifeState || null;
    const level = Number(bot.fetchLevel?.() || 0);
    const partyId = session.hotBackgroundPartyId || null;
    const decisionSeq = Number(DecisionEvents.statsFor(session).decisionSeq || 0);
    const last = session.sellTripCheck;
    if (last && last.items === items && last.count === items.length && last.life === life
        && last.revision === Number(bot.backpack.inventoryRevision || 0)
        && last.level === level && last.partyId === partyId && last.decisionSeq === decisionSeq
        && !(last.pauseEndsAt && now >= last.pauseEndsAt)) return last.need;
    const state = MarketListingPolicy.actorState(session);
    if (partyId) state.partyId = partyId;
    const forced = ItemDisposition.inventoryCleanupNeed(state, { now });
    const activity = DecisionEvents.held(session)?.network.activity;
    const pause = Number(state.stats?.marketSellRetryAfter || 0);
    const need = forced || (activity?.activity === 'selling' && pause <= now
        ? { reason: 'wish_funding', itemIds: activity.items } : null);
    session.sellTripCheck = { items, count: items.length, life, level, partyId, decisionSeq,
        revision: Number(bot.backpack.inventoryRevision || 0),
        pauseEndsAt: pause > now ? pause : 0, need };
    return need;
}

// A sell trip starts the cold sell pause, as the cold visit does, so a bag the
// town visit could not empty does not send the bot back on its next loot.
function pauseSelling(session, now = Date.now()) {
    const life = session.coldLifeState;
    if (!life) return;
    const delay = invoke('GameServer/Bot/Economy/ColdMarketListingService').SELL_RETRY_DELAY_MS;
    session.coldLifeState = { ...life, stats: { ...(life.stats || {}), marketSellRetryAfter: now + delay } };
    refreshPartyMemberships([session], invoke);
}

function isPartyCompanion(session) {
    return session.partyCompanion === true && !!session.followPlayerSession;
}

function startShopping(session, bot, BotAI, reason, townName = null) {
    if (isPartyCompanion(session)) {
        session.plan = 'following';
        session.shoppingTarget = undefined;
        session.shoppingDoneAnnounced = false;
        TownChatter.say(session, BotAI, 'shopping-deferred', Speech.lines('town.shopping-deferred'));
        return false;
    }

    // A failed physical town route has its own existing retry window. It
    // defers every errand on that route, including stock; an equipment
    // quote's retry alone must not block consumables. Hunt locally meanwhile.
    if (session.roleDecision?.reason === 'shopping_route_unreachable'
        && Number(session.companionEquipmentRetryAt || 0) > Date.now()) return 'deferred';

    const destination = townName ? Object.values(invoke('GameServer/World/TownRespawn').towns)
        .find(town => town.name === townName) : null;
    return BotTownTravel.request(session, bot, BotAI, reason, destination ? {
        destinationTown: { name: destination.name, x: destination.locX, y: destination.locY, z: destination.locZ }
    } : {});
}

function startWorkshopOrder(session, bot, BotAI, economy) {
    const leaf = economy?.network?.activity;
    if (!isSoloHunter(session) || leaf?.activity !== 'crafting' || leaf.kind !== 'craft'
        || /^resale:/.test(String(leaf.rootKey))
        || BotTownTravel.hasCombatThreat(session, bot) || bot.state?.fetchCasts?.()) return false;
    // The held decision carries the worker's craft plan (the selected dwarf,
    // fee, quantities and funding) through the physical visit.
    const stock = /^stock:(shots|potions|scrolls)$/.test(String(leaf.rootKey));
    const target = stock ? ShoppingState.stockWorkshopTarget(session, bot, economy)
        : economy.personalCraft && ShoppingState.workshopTarget(session, bot, economy.personalCraft);
    if (!target) return false;
    const trip = startShopping(session, bot, BotAI, 'Heading to town for my planned craft order.', target.town);
    if (trip === 'deferred' || trip === false) return false;
    session.shoppingTarget = target;
    session.shoppingServicePhase = 'workshop';
    session.shoppingDoneAnnounced = false;
    return true;
}

// The targets other live solo hunters hold. No index owns session.currentTargetId
// (it has writers in many modules, hot and cold), so this is one pass over the
// sessions; a caller that asks twice in one decision passes the set along.
function claimedTargetIds(session, sessions = invoke('GameServer/Bot/BotManager').sessions || []) {
    const startedAt = performance.now();
    const claimed = new Set();
    for (const otherSession of sessions) {
        if (otherSession === session || !otherSession.actor || !isSoloHunter(otherSession)) continue;
        if (!otherSession.currentTargetId || otherSession.actor.state.fetchDead()) continue;
        claimed.add(Number(otherSession.currentTargetId));
    }
    HotActorLodPolicy.recordSubsystem('claimScan', performance.now() - startedAt, sessions.length);
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
    // Target scans read the already held advice; they never prepare an
    // economy context of their own (standalone scans may precede admission).
    const leaf = isSoloHunter(session)
        ? session.heldEconomy?.network.activity || session.activationEconomyDecision?.activity : null;
    const materialNpc = invoke('GameServer/Bot/Population/ColdEconomyDecision').materialHunt(leaf)
        ? Number(leaf.npcId || 0) : 0;
    // Far-visible actors still choose a plausible nearby target, but do not
    // multiply the expensive claim scan by every NPC in a dense spawn cell.
    const eligibleNearbyNpcs = allNearbyNpcs
        .filter(npc => !materialNpc || Number(npc.fetchSelfId?.()) === materialNpc)
        .filter(npc => !options.spotOnly || SpotService.containsLocation(options.spotOnly, botLocation(npc))
            || (options.nearbyRadius > 0
                && SpotService.distance2d(botLocation(bot), botLocation(npc)) <= options.nearbyRadius))
        .filter((npc) => !options.excludeTargetId || npc.fetchId() !== options.excludeTargetId)
        .filter((npc) => !BotRaidSafety.isProtectedRaidEntity(npc))
        .filter((npc) => !invoke('GameServer/Bot/AI/HotResourceCompetition').blockedTarget(session, npc))
        .filter((npc) => BotHuntingTargetPolicy.canHunt(npc))
        .filter((npc) => npc.fetchAttackable() && !npc.isDead());
    const nearbyNpcs = limitTargetCandidates(session, bot, eligibleNearbyNpcs);
    const claimedIds = options.claimedIds || claimedTargetIds(session);
    const spotIdAt = (actor) => `${Math.floor(actor.fetchLocX() / SPOT_CELL_SIZE)}_${Math.floor(actor.fetchLocY() / SPOT_CELL_SIZE)}`;
    const currentSpotId = String(session.currentSpot?.id || spotIdAt(bot)).split(':')[0];
    const partyActors = session.followPlayerSession || session.hotBackgroundPartyId
        ? PartyAwareness.partyActors(session.followPlayerSession || session) : [];
    const matchupProfiles = TargetMatchup.actorProfiles(partyActors.length ? partyActors : [bot]);
    const matchupStats = TargetMatchup.profileStats(matchupProfiles);
    // Actor totals and attack profiles are invariant for this bounded scan.
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
            // The target's helpers, aggressive neighbours and minions come with it.
            const pull = SpotService.pullSizeFor(npc);
            const matchupTarget = TargetMatchup.targetView(npc, matchupStats);
            const targetMatchup = TargetMatchup.evaluate(matchupProfiles, matchupTarget);
            if (isSoloHunter(session) && partyActors.length <= 1) {
                const canHunt = TargetMatchup.soloCanHunt(matchupProfiles, BotPullEstimate.pullView(matchupTarget, pull));
                Object.assign(targetMatchup, canHunt);
            }
            const scoreContext = {
                attackable: npc.fetchAttackable(),
                raidEntity: BotRaidSafety.isProtectedRaidEntity(npc),
                dead: npc.isDead(),
                retryCooldown: targetOnCooldown(session, npc.fetchId()),
                botLevel: bot.fetchLevel(),
                minLevelGap: invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').economicHunt(session.coldLifeState || {}) ? -15 : undefined,
                npcLevel: npc.fetchLevel?.() || bot.fetchLevel(),
                distance: targetDistance(bot, npc),
                verticalGap: Math.abs(bot.fetchLocZ() - npc.fetchLocZ()),
                currentSpotId,
                npcSpotId,
                claimed,
                socialAllies: pull - 1,
                solo: isSoloHunter(session) && partyActors.length <= 1,
                botRole: BotRoles.combatRoleFor(bot),
                botOffenseRatio: matchupProfiles.length > 1 ? matchupProfiles.reduce((sum, profile) => sum
                    + (profile.role === 'mage' ? Number(profile.mAtk || 0) / Math.max(1, matchupTarget.mDef || 1)
                        : Number(profile.pAtk || 0) / Math.max(1, matchupTarget.pDef || 1)), 0) : undefined,
                targetMatchup,
                botPAtk: botCombatStats.pAtk,
                botMAtk: botCombatStats.mAtk,
                botPDef: botCombatStats.pDef,
                botMaxHp: botCombatStats.maxHp,
                npcPAtk: npc.fetchPAtk?.() ?? npc.fetchCollectivePAtk?.(),
                npcPDef: matchupTarget.pDef,
                npcMDef: matchupTarget.mDef,
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

    let ranked = BotTargetScorer.rank(candidates);
    // Cold routing can recover on easier ground when the current kit cannot
    // handle level-appropriate mobs. Once all safety gates pass, low-level
    // penalties are relative preferences: a negative score must not send a
    // solo body wandering past a safe visible mob. Economic hunts may already
    // admit the wider level band, so include those candidates in recovery too.
    if (!ranked.length && options.allowEasierTargets && isSoloHunter(session) && !session.hotBackgroundPartyId) {
        // Any deferred errand, including consumable restocking, can leave a
        // kit unable to handle the -15 band. Keep native reward penalties and
        // the full solo survival gate when recovering on easier local mobs.
        const allowTrivialTargets = !!session.deferredOccupation;
        const easier = candidates.filter(candidate => candidate.evaluation.reason === 'level_too_low'
            || candidate.evaluation.eligible && candidate.evaluation.levelGap < BotTargetScorer.MIN_LEVEL_GAP)
            .map(candidate => ({ ...candidate,
                evaluation: BotTargetScorer.score({ ...candidate.scoreContext, minLevelGap: -15, allowTrivialTargets }) }));
        ranked = easier.filter(candidate => candidate.evaluation.eligible && Number.isFinite(candidate.evaluation.score))
            .sort((first, second) => second.evaluation.score - first.evaluation.score);
        for (const candidate of ranked) candidate.evaluation.reasons.push('easier_ground');
    }
    // Prefer a fight we can finish, but retain a visible unready candidate
    // so the caller can recover instead of wandering while exhausted.
    const ordered = options.readyOnly
        ? [...ranked.filter(candidate => candidate.readiness.ready), ...ranked.filter(candidate => !candidate.readiness.ready)]
        : ranked;
    const scan = HuntingVisibility.select(session, 'solo', bot, ordered, candidate => candidate.npc);
    session.huntTargetScanPending = scan.pending;
    session.huntingTargetScan = { at: Date.now(), loc: botLocation(bot), radius,
        attackableNpcs: eligibleNearbyNpcs.length, eligibleAttackableNpcs: ranked.length };
    const readinessCandidate = options.readyOnly ? scan.candidate : null;
    const selected = options.readyOnly && !scan.candidate?.readiness.ready ? null : scan.candidate;
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

function liveCurrentNpcTarget(session, bot, radius = session.huntingSearchRadius || 2500) {
    const targetId = Number(session.currentTargetId || 0);
    if (!targetId) return null;

    const target = NpcObjectIndex.find(World, targetId);
    if (!target || target.fetchAttackable?.() !== true || target.isDead?.() === true || target.state?.fetchDead?.() === true) {
        return null;
    }
    return targetDistance(bot, target) <= radius ? target : null;
}

function encounterReadiness(bot, target) {
    return EncounterReadiness.evaluate({
        hp: bot.fetchHp(), maxHp: bot.fetchMaxHp(), mp: bot.fetchMp(), maxMp: bot.fetchMaxMp(),
        level: bot.fetchLevel(), manaDependent: BotRoles.shouldRestForMana(bot)
    }, { hp: target?.fetchHp?.(), maxHp: target?.fetchMaxHp?.(), level: target?.fetchLevel?.() });
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
    TownNpcApproach.reset(session);
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
        hpNeeded: readiness?.hpNeeded ?? RestPolicy.THRESHOLDS.solo.hp,
        mpRatio: readiness?.mpRatio ?? (bot.fetchMp() / Math.max(1, bot.fetchMaxMp())),
        mpNeeded: readiness?.mpNeeded ?? RestPolicy.THRESHOLDS.solo.mp,
        at: Date.now()
    };
    BotAI.say(session, Speech.line('combat.rest'), { ambient: true, key: 'rest' });
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

function failWalkRelocation(session, bot, relocation, reason) {
    expireSpotRelocation(session, bot, relocation);
    const now = Date.now();
    session.spotRetryAfter = Object.fromEntries(Object.entries(session.spotRetryAfter || {})
        .filter(([, retryAt]) => retryAt > now));
    session.spotRetryAfter[relocation.spotId] = now + FAILED_SPOT_RETRY_MS;
    session.lastSpotMoveAt = now;
    session.noTargetTicks = 0;
    session.lastSpotRelocation.method = `walk_${reason}`;
    session.lastDecision = { action: 'search_locally', reason, spotId: relocation.spotId };
}

function walkRouteFailed(session, relocation) {
    const path = session.lastPathfinding;
    return path?.routeUsable === false
        && Number(path.at) >= Number(relocation.lastCommandAt)
        && ['locX', 'locY', 'locZ'].every((key) =>
            path.requestedTo?.[key] === relocation.destination[key]);
}

function expireTimedOutSpotRelocation(session, bot) {
    const relocation = session.spotRelocation;
    if (!relocation) return false;
    const startedAt = Number(relocation.startedAt);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < MAX_SPOT_RELOCATION_MS) return false;
    if (relocation.method === 'town_gatekeeper') {
        BotSpotTravel.recoverOrDefer(session, bot, 'gatekeeper_route_timeout');
    } else if (relocation.method === 'walk') failWalkRelocation(session, bot, relocation, 'timeout');
    else expireSpotRelocation(session, bot, relocation);
    return true;
}

function issueWalkRelocation(session, bot, relocation) {
    const from = botLocation(bot);
    const previousPath = session.lastPathfinding;
    relocation.lastCommandAt = Date.now();
    bot.moveTo({ from, to: { ...relocation.destination } });
    if (session.lastPathfinding !== previousPath && walkRouteFailed(session, relocation)) {
        failWalkRelocation(session, bot, relocation, 'route_unavailable');
    }
}

function tickSpotRelocation(session, bot) {
    const relocation = session.spotRelocation;
    if (!relocation) return false;
    if (relocation.arrivalPending) return true;
    if (expireTimedOutSpotRelocation(session, bot)) return !!session.spotRelocation;
    if (relocation.method === 'town_gatekeeper') return BotSpotTravel.tick(session, bot);
    if (relocation.method === 'soe_gatekeeper') return true;

    const distance = SpotService.distance2d(botLocation(bot), relocation.destination);
    if (distance <= SPOT_ARRIVAL_RADIUS) {
        finishWalkRelocation(session, bot, SpotService.findById(relocation.spotId) || { id: relocation.spotId, center: relocation.destination });
        return false;
    }
    if (bot.state.fetchTowards() || session.moveTimer) return true;
    // Worker pathfinding can finish after moveTo returns. Only consume the
    // result for this destination and command, never an old combat route.
    if (walkRouteFailed(session, relocation)) {
        failWalkRelocation(session, bot, relocation, 'route_unavailable');
        return false;
    }
    if (Date.now() - Number(relocation.lastCommandAt || 0) >= 1000) issueWalkRelocation(session, bot, relocation);
    return !!session.spotRelocation;
}

function beginSpotRelocation(session, bot, spot, BotAI, deferredOccupation = null) {
    if (Number(session.townTravelRetryAt || 0) > Date.now()) return;
    const destination = { ...spot.center };
    session.currentTargetId = undefined;
    bot.unselect?.();
    session.noTargetTicks = 0;
    session.lastSpotMoveAt = Date.now();

    const finishedTownErrands = session.pendingFarmDepartureAnnouncement === true;
    delete session.pendingFarmDepartureAnnouncement;
    const destinationName = invoke('GameServer/Bot/AI/BotChatLocation').describe({ spot });
    TownChatter.say(session, BotAI, finishedTownErrands ? 'town-to-farm' : 'farm-relocation', finishedTownErrands
            ? Speech.lines('town.town-to-farm', { place: destinationName })
            : Speech.lines('town.farm-relocation', { place: destinationName }));

    // A bot with karma never uses SoE or a gatekeeper: it walks.
    const travelDistance = SpotService.distance2d(botLocation(bot), destination);
    if (travelDistance > MAX_WALK_SPOT_DISTANCE && !Karma.closesTowns(bot.fetchKarma?.())) {
        BotSpotTravel.start(session, bot, spot, destination);
        if (session.spotRelocation && deferredOccupation) session.spotRelocation.deferredOccupation = deferredOccupation;
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
    if (deferredOccupation) session.spotRelocation.deferredOccupation = deferredOccupation;
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
        session.spoilAttemptedTargetId = undefined;
        session.sweepAttemptedTargetId = undefined;
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
    session.spoilAttemptedTargetId = undefined;
    session.sweepAttemptedTargetId = undefined;
    bot.unselect();
    return true;
}

// Low MP sends only a bot that rests for mana away from a fight; a melee
// bot keeps swinging, as it keeps hunting with low MP.
function needsEmergencyRetreat(bot) {
    return RestPolicy.needsRest(bot,
        bot.fetchHp() / Math.max(1, bot.fetchMaxHp()),
        bot.fetchMp() / Math.max(1, bot.fetchMaxMp()));
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
    leaveShop,
    startWorkshopOrder,
    sellTripDue,
    pauseSelling,
    findPreferredMonster,
    limitTargetCandidates,
    claimedTargetIds,
    tick(session, bot, Generics, BotAI) {
        session.deferredOccupation = null;
        if (session.pendingTownTrip) {
            const trip = startShopping(session, bot, BotAI, session.pendingTownTrip.reason);
            if (trip !== 'deferred') return;
        }

        const floor = SurvivalFloor.forActor(bot, session.coldLifeState);
        if (isSoloHunter(session)) DecisionEvents.checkWallet(session, bot);
        if (floor?.action === 'rest') {
            TownNpcApproach.reset(session);
            bot.automation.abortAll(bot);
            session.plan = 'resting';
            return;
        }
        if (floor?.action === 'unload' && isSoloHunter(session)) {
            // Like the loot sell trip below and the cold sale visit: the trip starts
            // the sale retry, so a bag that sold nothing heavy hunts on at penalty 1.
            // A trip deferred by a fight comes back every tick: the retry it
            // already started stays, the trip itself waits in pendingTownTrip.
            const retry = Number(session.coldLifeState?.stats?.marketSellRetryAfter || 0);
            if (!(retry > Date.now())) pauseSelling(session);
            const trip = startShopping(session, bot, BotAI, `Inventory ${floor.reason}. Heading to town.`);
            if (trip !== 'deferred') return;
        }

        if (leaveShop(session, bot)) return;

        // 1. Expire buffs check for hunting bots. A hot bot already in a
        // starter town also refreshes once per visit before going back out.
        if (!session.followPlayerSession) {
            const townBuffVisit = HotTownRebuff.syncVisit(session, bot, BotAI);
            const townVisitNeedsRebuff = HotTownRebuff.needsVisit(session, townBuffVisit);
            if ((townVisitNeedsRebuff || BotBuffs.needsNewbieRefresh(bot, 0)) && HotTownRebuff.tripGuide(session, bot, BotAI)) {
                session.preBuffLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                session.preBuffPlan = 'hunting';
                session.resumeAfterBuff = townVisitNeedsRebuff
                    ? { plan: 'hunting', townVisitKey: townBuffVisit.key }
                    : undefined;
                session.plan = 'getting_buffed';
                session.currentTargetId = undefined;
                bot.automation.abortAll(bot);
                TownChatter.say(session, BotAI, 'heading-to-newbie-guide', townVisitNeedsRebuff
            ? Speech.lines('town.heading-to-newbie-guide.in-town')
            : Speech.lines('town.heading-to-newbie-guide.expired'));
                return;
            }
        }

        if (isSoloHunter(session) && (Number(session.companionEquipmentRetryAt || 0) <= Date.now()
            || /^stock:/.test(String(DecisionEvents.held(session)?.network.activity?.rootKey)))) {
            const economy = DecisionEvents.held(session);
            const wealthCraft = require('../../Economy/HotWealthCraftService');
            if (wealthCraft.canStart(session, economy.network.activity)) {
                wealthCraft.review(session, economy)
                    .catch(error => utils.infoWarn('BotWealth', '%s', error.message));
                return;
            }
            if (startWorkshopOrder(session, bot, BotAI, economy)) return;
            if (economy.network.activity?.activity === 'improving') {
                const state = MarketListingPolicy.actorState(session);
                const improvementService = invoke('GameServer/Bot/Economy/BotImprovementService');
                if (economy.network.activity.improvement?.kind !== 'enchant'
                    && !improvementService.selfCrystallization(economy.network.activity.improvement) && !improvementService.inTown(state)) {
                    const trip = startShopping(session, bot, BotAI, 'Heading to town for my planned improvement.');
                    if (trip !== 'deferred' && trip !== false) return;
                }
                improvementService.reviewHot(session)
                    .catch(error => utils.infoWarn('BotImprovement', '%s', error.message));
            }
            if (economy.network.activity?.activity === 'shopping') {
                const leaf = economy.network.activity;
                const state = invoke('GameServer/Bot/Economy/EconomyContext').stateForActor(bot, session);
                const amount = invoke('GameServer/Bot/Population/ColdEconomyDecision').remainingToOrder(leaf, state);
                if (amount > 0 && invoke('GameServer/Bot/Economy/ColdMarketService').canTravelForPurchase(state,
                    { selfId: Number(leaf.itemId || leaf.object?.itemId || leaf.object),
                        amount, town: leaf.town, valueHours: leaf.valueHours,
                        ...(!/^stock:/.test(String(leaf.rootKey)) && leaf.r > 0 ? { r: leaf.r } : {}) }, { economy })) {
                    const trip = startShopping(session, bot, BotAI, 'Heading to town for my next planned purchase.', leaf.town);
                    if (trip !== 'deferred' && trip !== false) return;
                }
            }
        }

        // 2. PK Spotting & Fleeing Check
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
        let spottedPk = null;
        let pkDistance = 99999;

        ActorQueries.near(World, bot, 1500).forEach((user) => {
            const other = user.actor;
            if (other && other !== bot && other.fetchIsOnline() && !other.state.fetchDead() && other.fetchKarma() > 0) {
                const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                if (dist < 1500 && dist < pkDistance) {
                    pkDistance = dist;
                    spottedPk = other;
                }
            }
        });

        // One roll per sighting: the same PK seen on the following ticks keeps it.
        if (session.pkSighting?.id !== spottedPk?.fetchId()) {
            session.pkSighting = spottedPk ? { id: spottedPk.fetchId(), at: Date.now() } : null;
        }
        if (spottedPk) {
            const allies = ActorQueries.near(World, bot, 1000).filter((otherSession) => {
                const other = otherSession.actor;
                if (!BotPvpRisk.isCombatAlly(session, otherSession, spottedPk)) return false;
                const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                return dist < 1000;
            });
            const pvpDecision = BotPvpRisk.evaluate({
                ...BotPvpRisk.sighting(session, spottedPk),
                key: ['pk', bot.fetchId(), session.pkSighting.id, session.pkSighting.at],
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
        // The danger moment reads the mobs on the bot from the same world scan.
        const threatScan = {};
        const incomingMonster = isSoloHunter(session)
            ? PartyAwareness.npcThreateningActor(session, undefined, threatScan)
            : PartyAwareness.recentIncomingNpc(session);
        if (incomingMonster) {
            invoke('GameServer/Bot/AI/PendingSweep').yieldToDefense(session, bot);
            if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'incoming_threat');
            if (BotRaidSafety.retreat(session, bot, incomingMonster, { distance: EMERGENCY_RETREAT_DISTANCE })) {
                return;
            }
            const currentGround = currentHuntingGround(session, bot);
            const matchupProfiles = TargetMatchup.actorProfiles([bot]);
            const groundSafety = currentGround
                ? BotHuntingGroundPolicy.evaluate(currentGround, { level: bot.fetchLevel() }, {
                    mode: 'solo',
                    matchupProfiles,
                    equipment: equippedItems(bot)
                })
                : { allowed: true };
            const moment = groundSafety.allowed ? DangerMoment.take(session, bot, incomingMonster,
                { profiles: matchupProfiles, near: threatScan.near }) : null;
            if (moment === 'drank') return;
            if ((!groundSafety.allowed || (moment ? moment === 'flee' : needsEmergencyRetreat(bot)))
                && EscapePolicy.canRetreatFrom(session, bot, incomingMonster, threatScan.near)) {
                if (groundSafety.allowed && isSoloHunter(session) &&
                    BotEmergencyFinisher.tryFinish(session, bot, incomingMonster, Generics, BotAI)) return;
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
        // The danger moment runs mid-swing too: a potion does not wait for the
        // swing flags, which a melee bot re-arms in the same callback.
        const moment = liveEncounterTarget ? DangerMoment.take(session, bot, liveEncounterTarget) : null;
        if (moment === 'drank') return;
        if (liveEncounterTarget && (moment ? moment === 'flee'
            : !nativeCombatActionInFlight && needsEmergencyRetreat(bot))
            && (BotRaidSafety.isProtectedRaidEntity(liveEncounterTarget)
                || EscapePolicy.canRetreatFrom(session, bot, liveEncounterTarget))) {
            if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'low_resources_in_combat');
            if (BotRaidSafety.retreat(session, bot, liveEncounterTarget, { distance: EMERGENCY_RETREAT_DISTANCE })) {
                return;
            }
            const ground = currentHuntingGround(session, bot);
            const allowed = !ground || BotHuntingGroundPolicy.evaluate(ground, { level: bot.fetchLevel() }, {
                mode: 'solo', equipment: equippedItems(bot)
            }).allowed;
            if (allowed && isSoloHunter(session) &&
                BotEmergencyFinisher.tryFinish(session, bot, liveEncounterTarget, Generics, BotAI)) return;
            retreatFromThreat(session, bot, liveEncounterTarget);
            return;
        }
        // Match RestingState's role-aware wake policy.  Melee/dps bots are
        // allowed to keep hunting with low MP; otherwise they immediately
        // wake again at full HP and oscillate between hunting and resting.
        // Between fights a solo bot heals itself where that beats sitting (T107).
        if (!encounterActionInFlight && !session.currentTargetId && isSoloHunter(session)
            && SoloSelfHeal.tryBetweenFights(session, bot, Generics)) return;
        if (!encounterActionInFlight && RestPolicy.needsRest(bot, hpRatio, mpRatio)) {
            beginVoluntaryRecovery(session, bot, BotAI);
            return;
        }

        if (isSoloHunter(session)) {
            const leaf = DecisionEvents.held(session)?.network.activity;
            if (leaf?.activity === 'selling' && sellTripDue(session, bot)) {
                const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
                pauseSelling(session);
                const trip = startShopping(session, bot, BotAI, `My bags are full of loot. Heading to ${closestTown.name} to sell and restock.`);
                if (trip !== 'deferred') return;
            }
            const ground = currentHuntingGround(session, bot);
            if (leaf?.activity && leaf.activity !== 'hunting' && !session.currentTargetId
                && !BotTownTravel.inCombat(session, bot)
                && (!ground || BotHuntingGroundPolicy.evaluate(ground, { level: bot.fetchLevel() }, {
                    mode: 'solo', equipment: equippedItems(bot)
                }).allowed)) {
                session.deferredOccupation = DecisionService.occupationKey(leaf);
                if (session.spotRelocation && session.spotRelocation.deferredOccupation !== session.deferredOccupation
                    && BotSpotTravel.cancel(session, bot, 'selected_occupation')) {
                    bot.automation?.abortAll?.(bot);
                }
                // A purchase not worth its own journey (or a craft awaiting
                // its station) keeps its wish. Earn locally, then recover to
                // safe ground if the expanded search cannot find a fight.
                // A quote refusal is not a
                // failed native transaction and must not reroll every tick.
                session.lastDecision = { action: 'search_locally', reason: 'occupation_deferred', activity: leaf.activity };
            }
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
                    spotRetryAfter: session.spotRetryAfter,
                    walkOnly: Karma.closesTowns(bot.fetchKarma?.()),
                    minDistance: 1,
                    mode: 'solo',
                    allowEasierSpots: true,
                    matchupProfiles: TargetMatchup.actorProfiles([bot]),
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

        if (invoke('GameServer/Bot/AI/PendingSweep').tick(session, bot, Generics, BotAI)) return;

        if (sellTripDue(session, bot)) {
            const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
            pauseSelling(session);
            const trip = startShopping(session, bot, BotAI, `My bags are full of loot. Heading to ${closestTown.name} to sell and restock.`);
            if (trip !== 'deferred') return;
        }

        let huntingDecision;
        if (isSoloHunter(session) && !session.currentTargetId) {
            reconcilePhysicalSpot(session, bot);
            const decision = huntingDecision = DecisionService.suggest(session.botStatus || BotAI.getStatus(session), session);
            if (decision.action === 'move_to_spot' && decision.spot) {
                session.lastDecision = { action: decision.action, reason: decision.reason,
                    spotId: decision.spot.id, spotName: decision.spot.name };
                beginSpotRelocation(session, bot, decision.spot, BotAI, decision.deferredOccupation);
                return;
            }
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
                            BotAI.say(session, BotAI.getRandomPhrase('victory'), { ambient: true, key: 'victory' });
                        }
                        clearTarget(session, bot, targetId);
                    } else {
                        const npcAggroedOnBot = Number(npc.fetchDestId?.() || 0) === Number(bot.fetchId());
                        if (!npcAggroedOnBot && !bot.state.fetchHits() && !bot.state.fetchCasts()
                            && !HuntingVisibility.canSee(bot, npc)) {
                            bot.automation?.abortAll?.(bot);
                            clearTarget(session, bot, targetId, true);
                            session.lastDecision = { action: 'abandon_target', reason: 'target_not_visible', targetId };
                            return;
                        }
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

                        const claimedIds = claimedTargetIds(session);
                        if (claimedIds.has(Number(npc.fetchId()))) {
                            const alternateMonster = findPreferredMonster(session, bot, 2500, {
                                excludeTargetId: npc.fetchId(),
                                freeOnly: true,
                                claimedIds
                            });
                            if (alternateMonster) {
                                assignTarget(session, bot, alternateMonster);
                                BotAI.executeCombat(session, bot, alternateMonster, Generics);
                                return;
                            }
                        }

                        const crystal = bot.backpack.fetchItems().find(item => invoke('GameServer/Items/SoulCrystalProgression').crystal(item));
                        if (crystal && npc.fetchHp() <= npc.fetchMaxHp() / 2 && !npc.fetchSoulCrystalAbsorber?.(bot)
                            && invoke('GameServer/Items/SoulCrystalProgression').canUse(session, crystal, npc)) {
                            const itemSkill = invoke('GameServer/Items/C4ItemSkills').resolve(crystal.fetchSelfId());
                            const skill = bot.backpack.buildItemSkill(itemSkill);
                            if (skill && bot.fetchMp() >= skill.fetchConsumedMp() && bot.canUseSkill?.(skill) !== false) {
                                bot.select({ id: npc.fetchId() });
                                bot.backpack.useDrainSoulItem(session, crystal.fetchId(), itemSkill, skill);
                                if (bot.state.fetchCasts()) return;
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
            const expanded = isSoloHunter(session) && Number(session.noTargetTicks || 0) >= 2 && session.currentSpot;
            const searchRadius = expanded ? Math.ceil(SPOT_CELL_SIZE * Math.SQRT2) : LOCAL_TARGET_SEARCH_RADIUS;
            session.huntingSearchRadius = searchRadius;
            // Prefer unclaimed mobs so solo bots do not form accidental trains.
            const closestMonster = findPreferredMonster(session, bot, searchRadius, {
                readyOnly: isSoloHunter(session),
                allowEasierTargets: isSoloHunter(session),
                spotOnly: expanded ? session.currentSpot : null,
                // Expanding the field scan must retain nearby candidates
                // across grid borders; only distant targets stay on this spot.
                nearbyRadius: LOCAL_TARGET_SEARCH_RADIUS
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
                    BotAI.say(session, BotAI.getRandomPhrase('foundTarget', closestMonster.fetchName()), { ambient: true, key: 'target' });
                }
                BotAI.executeCombat(session, bot, closestMonster, Generics);
            } else {
                if (session.huntTargetScanPending) return;
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

                const decision = huntingDecision || DecisionService.suggest(session.botStatus || BotAI.getStatus(session), session);
                session.lastDecision = {
                    action: decision.action,
                    reason: decision.reason,
                    activity: decision.activity,
                    spotId: decision.spot?.id || null,
                    spotName: decision.spot?.name || null
                };

                if (decision.action === 'move_to_spot' && decision.spot) {
                    beginSpotRelocation(session, bot, decision.spot, BotAI, decision.deferredOccupation);
                    return;
                }

                // Finish the current search walk before choosing another point.
                // Target scans above can still interrupt it for a real encounter.
                if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) return;

                // Wandering to search for monsters in starting zones if none nearby
                if (Math.random() < 0.50) {
                    if (!session.initialSpawnCoord) {
                        session.initialSpawnCoord = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                    }
                    const baseCoord = session.initialSpawnCoord;
                    
                    // Wander up to 2500 units away from their initial spawn coordinate to hunt!
                    for (let attempt = 0; attempt < HuntingVisibility.CHECKS_PER_SCAN; attempt++) {
                        const wanderX = baseCoord.locX + utils.oneFromSpan(-2500, 2500);
                        const wanderY = baseCoord.locY + utils.oneFromSpan(-2500, 2500);
                        if (!GeodataEngine.hasLineOfSight(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ(),
                            wanderX, wanderY, bot.fetchLocZ())) continue;
                        bot.moveTo({ from: botLocation(bot),
                            to: { locX: wanderX, locY: wanderY, locZ: bot.fetchLocZ() } });
                        break;
                    }
                }
            }
        }
    }
};
