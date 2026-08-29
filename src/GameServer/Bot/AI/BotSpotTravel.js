const ServerResponse = invoke('GameServer/Network/Response');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const TownGatekeeperCatalog = invoke('GameServer/Bot/AI/TownGatekeeperCatalog');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');

const SOE_SKILL_ID = 2013;
const SOE_CAST_MS = 20000;
const TELEPORT_SETTLE_MS = 1200;
const GATEKEEPER_INTERACTION_RADIUS = 300;
const MOVE_RETRY_MS = 1000;

function hasFiniteCoordinate(value) {
    return value !== null
        && value !== undefined
        && String(value).trim() !== ''
        && Number.isFinite(Number(value));
}

function active(session) {
    return !!session?.spotRelocation;
}

function cancel(session, bot, reason = 'cancelled') {
    if (!session?.spotRelocation) return false;
    if (session.spotRelocation.arrivalPending) return false;
    const relocation = session.spotRelocation;
    session.spotRelocation = undefined;
    bot?.state?.setCasts?.(false);
    TownNpcApproach.reset(session);
    CompanionNavigationRecovery.clear(session);
    session.lastSpotRelocation = {
        spotId: relocation.spotId,
        method: relocation.method,
        reason,
        at: Date.now()
    };
    return true;
}

function botLocation(bot) {
    return { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
}

function recordArrival(bot, spot, method, summary) {
    Promise.resolve(BotEventJournal.record({
        botId: bot.fetchId(),
        eventType: 'travel_complete',
        summary,
        weight: 2,
        dedupeKey: `spot-travel:${bot.fetchId()}:${spot.id}`,
        coalesceWindowMs: 30000,
        meta: { spotId: spot.id, method }
    })).catch(() => {});
}

function completeTeleport(session, bot, spot, relocation, method) {
    const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
    TeleportTo(session, bot, relocation.destination);
    const arrivedSpot = SpotService.findById(spot.id) || spot;
    SpotService.assignSpot(session, arrivedSpot);
    session.initialSpawnCoord = { ...arrivedSpot.center };
    session.townRoutePlan = null;
    TownNpcApproach.reset(session);
    CompanionNavigationRecovery.clear(session);
    session.spotRelocation = { ...relocation, arrivalPending: true };
    setTimeout(() => {
        if (session.spotRelocation?.token !== relocation.token) return;
        session.spotRelocation = undefined;
        session.lastSpotRelocation = {
            spotId: arrivedSpot.id,
            method,
            at: Date.now()
        };
    }, TELEPORT_SETTLE_MS);
    recordArrival(
        bot,
        arrivedSpot,
        method,
        method === 'town_gatekeeper'
            ? `${bot.fetchName?.() || 'Bot'} left ${relocation.gatekeeper?.town || 'town'} through ${relocation.gatekeeper?.name || 'the gatekeeper'} and reached ${arrivedSpot.name || 'a hunting ground'}.`
            : `${bot.fetchName?.() || 'Bot'} reached ${arrivedSpot.name || 'a hunting ground'} via SoE and gatekeeper.`
    );
}

function start(session, bot, spot, targetLoc = null) {
    if (!session || !bot || !spot) return false;
    if (session.spotRelocation) return session.spotRelocation.spotId === spot.id;

    const token = Symbol('spot-relocation');
    const destination = { ...(targetLoc || spot.center) };
    if (!['locX', 'locY', 'locZ'].every((key) => hasFiniteCoordinate(destination[key]))) return false;
    destination.locX = Number(destination.locX);
    destination.locY = Number(destination.locY);
    destination.locZ = Number(destination.locZ);
    session.spotRelocation = {
        token,
        spotId: spot.id,
        destination,
        startedAt: Date.now(),
        completesAt: Date.now() + SOE_CAST_MS,
        method: 'soe_gatekeeper'
    };
    bot.state.setCasts(true);
    const skill = {
        fetchSelfId: () => SOE_SKILL_ID,
        fetchCalculatedHitTime: () => SOE_CAST_MS,
        fetchReuseTime: () => 0
    };
    session.dataSendToMeAndOthers?.(ServerResponse.skillStarted(bot, bot.fetchId(), skill), bot);

    setTimeout(() => {
        const relocation = session.spotRelocation;
        if (!relocation || relocation.token !== token) return;
        if (bot.isDead?.()) {
            cancel(session, bot, 'death');
            return;
        }
        if (!bot.state.fetchCasts?.()) {
            cancel(session, bot, 'cast_interrupted');
            return;
        }
        if (BotTownTravel.hasCombatThreat(session, bot)) {
            cancel(session, bot, 'combat_interrupt');
            return;
        }

        bot.state.setCasts(false);
        completeTeleport(session, bot, spot, relocation, 'soe_gatekeeper');
    }, SOE_CAST_MS);
    return true;
}

function startViaTownGatekeeper(session, bot, spot, targetLoc = null, options = {}) {
    if (!session || !bot || !spot) return false;
    if (session.spotRelocation) return session.spotRelocation.spotId === spot.id;

    const destination = { ...(targetLoc || spot.center) };
    if (!['locX', 'locY', 'locZ'].every((key) => hasFiniteCoordinate(destination[key]))) return false;
    const from = botLocation(bot);
    const gatekeeper = options.townName
        ? TownGatekeeperCatalog.targetForTown(options.townName, { from })
        : TownGatekeeperCatalog.targetNear(from);
    if (!gatekeeper) return false;

    TownNpcApproach.reset(session);
    CompanionNavigationRecovery.clear(session);
    session.spotRelocation = {
        token: Symbol('town-gatekeeper-relocation'),
        spotId: spot.id,
        destination: {
            locX: Number(destination.locX),
            locY: Number(destination.locY),
            locZ: Number(destination.locZ)
        },
        gatekeeper,
        startedAt: Date.now(),
        lastCommandAt: 0,
        method: 'town_gatekeeper'
    };
    tick(session, bot);
    return true;
}

function tick(session, bot) {
    const relocation = session?.spotRelocation;
    if (!relocation || relocation.method !== 'town_gatekeeper') return false;
    if (relocation.arrivalPending) return true;
    if (bot.isDead?.()) {
        cancel(session, bot, 'death');
        return false;
    }
    if (BotTownTravel.hasCombatThreat(session, bot)) {
        cancel(session, bot, 'combat_interrupt');
        return false;
    }

    const approach = TownNpcApproach.plan(session, bot, relocation.gatekeeper, 'town_gatekeeper');
    const distanceToGatekeeper = Math.hypot(
        bot.fetchLocX() - relocation.gatekeeper.locX,
        bot.fetchLocY() - relocation.gatekeeper.locY
    );
    if (approach?.ready || (!approach && distanceToGatekeeper <= GATEKEEPER_INTERACTION_RADIUS)) {
        const spot = SpotService.findById(relocation.spotId) || {
            id: relocation.spotId,
            name: 'a hunting ground',
            center: relocation.destination
        };
        completeTeleport(session, bot, spot, relocation, 'town_gatekeeper');
        return true;
    }

    if (Date.now() - Number(relocation.lastCommandAt || 0) < MOVE_RETRY_MS) return true;
    relocation.lastCommandAt = Date.now();
    const navigation = CompanionNavigationRecovery.move(
        session,
        bot,
        approach?.destination || relocation.gatekeeper,
        'town_gatekeeper_departure',
        {
            targetActor: null,
            arrivalRadius: approach?.arrivalRadius || GATEKEEPER_INTERACTION_RADIUS
        }
    );
    if (navigation.status === 'exhausted') {
        if (approach?.phase === 'staging') {
            TownNpcApproach.skipStaging(session);
            CompanionNavigationRecovery.clear(session);
            return true;
        }

        const spot = SpotService.findById(relocation.spotId) || {
            id: relocation.spotId,
            name: 'a hunting ground',
            center: relocation.destination
        };
        const destination = { ...relocation.destination };
        cancel(session, bot, 'gatekeeper_route_unreachable');
        return start(session, bot, spot, destination);
    }
    return true;
}

module.exports = {
    GATEKEEPER_INTERACTION_RADIUS,
    SOE_CAST_MS,
    TELEPORT_SETTLE_MS,
    active,
    cancel,
    start,
    startViaTownGatekeeper,
    tick
};
