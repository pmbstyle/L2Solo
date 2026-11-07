const Runtime = require('./Runtime');
const Services = require('./Services');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const VisitPolicy = require('./VisitPolicy');
const { local } = require('./VisitNeed');
const VISIT_MS = 180000;
const Rebuff = invoke('GameServer/Bot/AI/Rebuff');
// lazy: HotTownRebuff's chain reads the hall modules.
const HotTownRebuff = () => invoke('GameServer/Bot/AI/HotTownRebuff');

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
// A visit ended (done, refused or failed: none follows until the bot's rebuff answers
// the hall again).
function finish(session, actor) {
    session.clanHallVisit = null;
    if (session.coldLifeState?.stats) {
        session.coldLifeState.stats.clanHallVisit = null;
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
// A body's hall visit: started when its rebuff answered the hall (Bot/AI/Rebuff, once
// per answer), then carried out at the manager (its support, and its recovery inside).
function tick(session, actor, timestamp = Date.now()) {
    if (session.clanHallVisit === undefined)
        session.clanHallVisit = session.coldLifeState?.stats?.clanHallVisit || null;
    const visit = session.clanHallVisit;
    // No visit and no answer: nothing to read this tick.
    if (!visit && !Rebuff.pending(invoke('GameServer/Bot/AI/DecisionEvents').statsFor(session), 'hall')) return false;
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
        if (visit) finish(session, actor);
        return false;
    }
    const grouped = view.grouped;
    if (!visit) {
        // A free moment of a hunt or a rest: the answer is taken (done) and the visit starts.
        if (!['hunting', 'resting'].includes(session.plan) || !HotTownRebuff().takeAnswer(session, 'hall')) return false;
        const nearby = local(actor, hall);
        session.clanHallVisit = { hallId: hall.id, startedAt: timestamp, expiresAt: timestamp + VISIT_MS };
        actor.automation?.abortAll?.(actor);
        actor.unselect?.();
        if (!nearby) {
            Approach.reset(session);
            Navigation.clear(session);
            const teleported = invoke('GameServer/Actor/Generics/TeleportTo')(session, actor, { ...hall.spawn });
            if (!teleported) {
                finish(session, actor);
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
        finish(session, actor);
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
            finish(session, actor);
            return false;
        }
        return true;
    }
    Approach.reset(session);
    Navigation.clear(session);
    const result = Services.buffBot(session, actor, npc, timestamp);
    if (!result.ok) {
        finish(session, actor);
        return false;
    }
    if (!grouped && Runtime.Policy.inside(hall, actor) && Services.recovery(actor, hall, timestamp)) {
        if (!actor.state?.fetchSeated?.()) {
            actor.state.setSeated(true);
            session.dataSendToOthers?.(invoke('GameServer/Network/Response').sitAndStand(actor), actor);
        }
        actor.automation?.replenishVitals?.(actor);
        return true;
    }
    finish(session, actor);
    if (!grouped) {
        session.plan = 'hunting';
        invoke('GameServer/Bot/AI/SpotService').leaveSpot(session);
        session.pendingFarmDepartureAnnouncement = true;
        return require('./Departure').hot(session, actor, hall, timestamp);
    }
    return false;
}
module.exports = { VISIT_MS, safe, local, restartHall, tick, finish };
