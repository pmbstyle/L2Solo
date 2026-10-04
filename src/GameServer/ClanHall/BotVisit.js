const Runtime = require('./Runtime');
const Services = require('./Services');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const VisitPolicy = require('./VisitPolicy');
const RETRY_MS = 300000;
const VISIT_MS = 180000;

// A moment the bot can leave what it is doing: no fight, no travel. Who may
// use the hall at all is VisitPolicy's rule, shared with the cold visit.
function safe(session, actor) {
    return (
        !actor.isDead?.() &&
        !actor.state?.fetchDead?.() &&
        !actor.state?.fetchCombats?.() &&
        !actor.state?.fetchHits?.() &&
        !actor.state?.fetchCasts?.() &&
        !session.pvpDefense &&
        !session.currentTargetId &&
        !session.incomingThreatId &&
        !session.spotRelocation &&
        !session.townEscape &&
        !session.pendingTownTrip
    );
}
function local(actor, hall) {
    const p = Services.point(actor);
    const town = invoke('GameServer/World/TownRespawn').getClosestTown(p.locX, p.locY, p.locZ);
    return (
        Runtime.Policy.inside(hall, actor) ||
        (town?.name === hall.town && Math.hypot(p.locX - hall.spawn.locX, p.locY - hall.spawn.locY) <= 7500)
    );
}
function finish(session, actor, retryAt) {
    session.clanHallVisit = null;
    session.clanHallRetryAt = retryAt;
    if (session.coldLifeState?.stats) {
        session.coldLifeState.stats.clanHallVisit = null;
        session.coldLifeState.stats.clanHallRetryAt = retryAt;
        session.coldLifeState.stats.travel = null;
        // The session may hold the cached state itself: its trip ended in place.
        invoke('GameServer/Bot/Population/BotLifeState').refreshOccupancy(session.coldLifeState);
    }
    Approach.reset(session);
    Navigation.clear(session);
    if (actor.state?.fetchSeated?.()) {
        actor.state.setSeated(false);
        session.dataSendToOthers?.(invoke('GameServer/Network/Response').sitAndStand(actor), actor);
    }
}
// The hall a dead hot bot restarts in, or null for a town restart.
function restartHall(session, actor) {
    return VisitPolicy.mayUse(VisitPolicy.fromSession(session, actor), { restart: true })
        ? Runtime.forActor(actor) : null;
}
function tick(session, actor, timestamp = Date.now()) {
    if (session.clanHallVisit === undefined)
        session.clanHallVisit = session.coldLifeState?.stats?.clanHallVisit || null;
    const visit = session.clanHallVisit;
    const hall = Runtime.forActor(actor);
    const npc = Services.manager(hall);
    const blocked =
        !safe(session, actor) ||
        !Services.available(hall, timestamp) ||
        !npc ||
        (visit && (visit.hallId !== hall.id || timestamp >= visit.expiresAt));
    // Built only for a bot that has a working hall and a free moment.
    const view = blocked ? null : VisitPolicy.fromSession(session, actor);
    if (blocked || !VisitPolicy.mayUse(view, { atManager: Services.near(actor, npc) })) {
        if (visit) finish(session, actor, timestamp + RETRY_MS);
        return false;
    }
    const grouped = view.grouped;
    if (!visit) {
        if (
            !['hunting', 'resting', 'following'].includes(session.plan) ||
            timestamp < Number(session.clanHallRetryAt ?? session.coldLifeState?.stats?.clanHallRetryAt ?? 0)
        )
            return false;
        const needsBuffs = Services.missing(actor, hall, timestamp).length > 0;
        const nearby = local(actor, hall);
        if (!needsBuffs && (!nearby || !Services.recovery(actor, hall))) return false;
        session.clanHallVisit = { hallId: hall.id, startedAt: timestamp, expiresAt: timestamp + VISIT_MS };
        actor.automation?.abortAll?.(actor);
        actor.unselect?.();
        if (!nearby) {
            Approach.reset(session);
            Navigation.clear(session);
            const teleported = invoke('GameServer/Actor/Generics/TeleportTo')(session, actor, { ...hall.spawn });
            if (!teleported) {
                finish(session, actor, timestamp + RETRY_MS);
                return false;
            }
            // TeleportTo updates the actor location after one second. Do not
            // start walking or grant support using its old field coordinates.
            session.clanHallVisit.arrivalAt = timestamp + 1200;
        }
    }
    session.roleDecision = {
        ...(session.roleDecision || {}),
        action: 'refresh_buffs',
        reason: 'clan_hall_services',
        at: timestamp
    };
    if (timestamp < Number(session.clanHallVisit.arrivalAt || 0)) return true;
    if (session.clanHallVisit.arrivalAt && !local(actor, hall)) {
        finish(session, actor, timestamp + RETRY_MS);
        return false;
    }
    if (!Services.near(actor, npc)) {
        const target = {
            ...Services.point(npc),
            npcSelfId: npc.fetchSelfId(),
            actorId: npc.fetchId(),
            head: npc.fetchHead?.(),
            name: npc.fetchName?.() || 'Clan Hall Manager',
            town: hall.town
        };
        const approach = Approach.plan(session, actor, target, 'clan_hall');
        if (approach?.waiting) return true;
        const route = Navigation.move(session, actor, approach?.destination || target, 'clan_hall', {
            targetActor: null,
            arrivalRadius: approach?.arrivalRadius ?? 100
        });
        if (route.status === 'exhausted') {
            finish(session, actor, timestamp + RETRY_MS);
            return false;
        }
        return true;
    }
    Approach.reset(session);
    Navigation.clear(session);
    const result = Services.buffBot(session, actor, npc, timestamp);
    if (!result.ok) {
        finish(session, actor, timestamp + RETRY_MS);
        return false;
    }
    if (!grouped && Runtime.Policy.inside(hall, actor) && Services.recovery(actor, hall)) {
        if (!actor.state?.fetchSeated?.()) {
            actor.state.setSeated(true);
            session.dataSendToOthers?.(invoke('GameServer/Network/Response').sitAndStand(actor), actor);
        }
        actor.automation?.replenishVitals?.(actor);
        return true;
    }
    finish(session, actor, timestamp + 60000);
    if (!grouped) {
        session.plan = 'hunting';
        session.currentSpot = null;
        session.pendingFarmDepartureAnnouncement = true;
        return require('./Departure').hot(session, actor, hall, timestamp);
    }
    return false;
}
module.exports = { RETRY_MS, VISIT_MS, safe, local, restartHall, tick, finish };
