const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const TownGatekeeperCatalog = invoke('GameServer/Bot/AI/TownGatekeeperCatalog');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const TownRespawn = invoke('GameServer/World/TownRespawn');

const RETRY_DELAY_MS = 5000;

function pointOf(actor) {
    return {
        locX: Number(actor?.fetchLocX?.() ?? actor?.locX ?? 0),
        locY: Number(actor?.fetchLocY?.() ?? actor?.locY ?? 0),
        locZ: Number(actor?.fetchLocZ?.() ?? actor?.locZ ?? 0)
    };
}

function townCenter(name) {
    const town = Object.values(TownRespawn.towns || {}).find((candidate) => candidate.name === name);
    return town ? { locX: town.locX, locY: town.locY, locZ: town.locZ } : null;
}

function context(bot, leader, options = {}) {
    const botLoc = pointOf(bot);
    const leaderLoc = pointOf(leader);
    const sourceGatekeeper = TownGatekeeperCatalog.targetNear(botLoc, options);
    const targetGatekeeper = TownGatekeeperCatalog.targetNear(leaderLoc, options);
    if (!sourceGatekeeper || !targetGatekeeper || sourceGatekeeper.town === targetGatekeeper.town) return null;

    const destination = townCenter(targetGatekeeper.town);
    if (!destination) return null;
    return {
        sourceTown: sourceGatekeeper.town,
        targetTown: targetGatekeeper.town,
        gatekeeper: sourceGatekeeper,
        destination
    };
}

function sameTown(bot, leader, options = {}) {
    const botGatekeeper = TownGatekeeperCatalog.targetNear(pointOf(bot), options);
    const leaderGatekeeper = TownGatekeeperCatalog.targetNear(pointOf(leader), options);
    return !!botGatekeeper && !!leaderGatekeeper && botGatekeeper.town === leaderGatekeeper.town;
}

function clear(session) {
    if (!session) return;
    delete session.companionTownTransit;
    TownNpcApproach.reset(session);
    CompanionNavigationRecovery.clear(session);
}

function start(session, bot, leader, options = {}) {
    if (!session || !bot || !leader) return false;
    const transit = context(bot, leader, options);
    if (!transit) return false;
    session.companionTownTransit = {
        ...transit,
        startedAt: Date.now(),
        retryAt: 0
    };
    TownNpcApproach.reset(session);
    CompanionNavigationRecovery.clear(session);
    return true;
}

function tick(session, bot, leader, options = {}) {
    let transit = session?.companionTownTransit;
    const current = context(bot, leader, options);

    if (!transit) {
        if (!current || !start(session, bot, leader, options)) return { handled: false };
        transit = session.companionTownTransit;
    } else if (!current) {
        clear(session);
        return { handled: false, completed: true };
    } else if (current.sourceTown !== transit.sourceTown || current.targetTown !== transit.targetTown) {
        clear(session);
        start(session, bot, leader, options);
        transit = session.companionTownTransit;
    }

    if (Number(transit.retryAt || 0) > Date.now()) {
        return { handled: true, status: 'waiting', transit };
    }

    const approach = TownNpcApproach.plan(session, bot, transit.gatekeeper, 'intertown_gatekeeper');
    const distanceToGatekeeper = Math.hypot(
        bot.fetchLocX() - transit.gatekeeper.locX,
        bot.fetchLocY() - transit.gatekeeper.locY
    );
    if (approach?.ready || (!approach && distanceToGatekeeper <= 300)) {
        const destination = { ...transit.destination };
        clear(session);
        const teleportTo = options.teleportTo || invoke('GameServer/Actor/Generics/TeleportTo');
        teleportTo(session, bot, destination);
        return { handled: true, status: 'teleported', completed: true, destination };
    }

    const navigationTarget = approach?.destination || transit.gatekeeper;
    const navigation = CompanionNavigationRecovery.move(
        session,
        bot,
        navigationTarget,
        'intertown_gatekeeper',
        {
            targetActor: null,
            arrivalRadius: approach?.arrivalRadius || 300
        }
    );
    if (navigation.status === 'exhausted') {
        if (approach?.phase === 'staging') {
            TownNpcApproach.skipStaging(session);
        } else {
            TownNpcApproach.reset(session);
            transit.retryAt = Date.now() + RETRY_DELAY_MS;
        }
        CompanionNavigationRecovery.clear(session);
    }

    return { handled: true, status: navigation.status, transit };
}

module.exports = {
    RETRY_DELAY_MS,
    clear,
    context,
    sameTown,
    start,
    tick,
    townCenter
};
