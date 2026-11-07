const World = invoke('GameServer/World/World');
const NpcAggro = invoke('GameServer/Npc/NpcAggro');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');

const PARTY_RADIUS = 450;
const TARGET_DRIFT = 120;
const ROUTE_TOLERANCE = 64;
const REJECTED_ROUTE_TTL_MS = 5000;
const CAST_RANGE_MARGIN = 32;
const GEODATA_CELL_SIZE = 16;

function loc(actor) {
    return {
        locX: Number(actor.fetchLocX?.() ?? actor.locX),
        locY: Number(actor.fetchLocY?.() ?? actor.locY),
        locZ: Number(actor.fetchLocZ?.() ?? actor.locZ)
    };
}

function distance(first, second) {
    return Math.hypot(first.locX - second.locX, first.locY - second.locY);
}

function closestPoint(target, from, to) {
    const dx = to.locX - from.locX;
    const dy = to.locY - from.locY;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
        ((target.locX - from.locX) * dx + (target.locY - from.locY) * dy) / lengthSquared));
    return {
        locX: from.locX + dx * ratio,
        locY: from.locY + dy * ratio,
        locZ: from.locZ + (to.locZ - from.locZ) * ratio
    };
}

function visibleFrom(hazard, target) {
    return Math.abs(target.locZ - hazard.locZ) <= NpcAggro.MAX_AGGRO_Z_DIFFERENCE &&
        Geodata.hasLineOfSight(hazard.locX, hazard.locY, hazard.locZ, target.locX, target.locY, target.locZ);
}

function segmentExposes(from, to, hazard, clearance) {
    const nearest = closestPoint(hazard, from, to);
    const threshold = clearance - 1e-6;
    if (distance(nearest, hazard) >= threshold) return false;
    if (visibleFrom(hazard, nearest)) return true;

    // The closest point can be hidden by a wall while another part of the
    // same leg passes a doorway. Check the whole interval inside the circle.
    const dx = to.locX - from.locX;
    const dy = to.locY - from.locY;
    const dz = to.locZ - from.locZ;
    const length = distance(from, to);
    if (length === 0) return false;
    const projection = ((hazard.locX - from.locX) * dx + (hazard.locY - from.locY) * dy) / length;
    const perpendicularSquared = Math.max(0, distance(from, hazard) ** 2 - projection ** 2);
    const halfSpan = Math.sqrt(Math.max(0, threshold ** 2 - perpendicularSquared));
    let entry = Math.max(0, (projection - halfSpan) / length);
    let exit = Math.min(1, (projection + halfSpan) / length);
    if (dz === 0) {
        if (Math.abs(from.locZ - hazard.locZ) > NpcAggro.MAX_AGGRO_Z_DIFFERENCE) return false;
    } else {
        const lower = (hazard.locZ - NpcAggro.MAX_AGGRO_Z_DIFFERENCE - from.locZ) / dz;
        const upper = (hazard.locZ + NpcAggro.MAX_AGGRO_Z_DIFFERENCE - from.locZ) / dz;
        entry = Math.max(entry, Math.min(lower, upper));
        exit = Math.min(exit, Math.max(lower, upper));
    }
    if (entry > exit) return false;
    // Native LOS resolves target cells. Walk their boundaries so a diagonal
    // leg cannot skip a briefly crossed cell containing a visible doorway.
    const boundaries = [entry, exit];
    for (const coordinate of ['locX', 'locY']) {
        const change = to[coordinate] - from[coordinate];
        if (change === 0) continue;
        const start = from[coordinate] + change * entry;
        const end = from[coordinate] + change * exit;
        const firstBoundary = (Math.floor(Math.min(start, end) / GEODATA_CELL_SIZE) + 1) * GEODATA_CELL_SIZE;
        for (let boundary = firstBoundary; boundary < Math.max(start, end); boundary += GEODATA_CELL_SIZE) {
            boundaries.push((boundary - from[coordinate]) / change);
        }
    }
    boundaries.sort((first, second) => first - second);
    const exposesAt = fraction => {
        const sample = { locX: from.locX + dx * fraction, locY: from.locY + dy * fraction, locZ: from.locZ + dz * fraction };
        return distance(sample, hazard) < threshold && visibleFrom(hazard, sample);
    };
    if (exposesAt(entry) || exposesAt(exit)) return true;
    for (let index = 1; index < boundaries.length; index++) {
        if (exposesAt((boundaries[index - 1] + boundaries[index]) / 2)) return true;
    }
    return false;
}

// Check the actual geodata route as well as its endpoint. Already exposed
// companions may move away from a hostile, but must not move deeper into it.
function routeAllowed(session, bot, route, goal, { complete = true, endpointOnly = false } = {}) {
    const leader = session.followPlayerSession?.actor;
    if (!leader || session.partyCompanion !== true) return false;
    const anchor = loc(leader);
    const from = loc(bot);
    const waypoints = [from, ...route.map(loc)];
    const routeLimit = Math.max(PARTY_RADIUS, distance(from, anchor)) + ROUTE_TOLERANCE;
    if (distance(loc(goal), anchor) > PARTY_RADIUS ||
        (complete && distance(waypoints.at(-1), anchor) > PARTY_RADIUS) ||
        waypoints.some(point => distance(point, anchor) > routeLimit)) return false;

    const scanRadius = Math.max(...waypoints.map(point => distance(from, point)))
        + NpcAggro.MAX_AGGRO_RADIUS + ROUTE_TOLERANCE;
    const hazards = World.fetchNpcsInRadius(from.locX, from.locY, scanRadius)
        // Spawn grace can expire during a route. A selected target alone is
        // not combat; only the native combat state makes a mob already engaged.
        .filter(npc => NpcAggro.isEligible(npc, Infinity) && !npc.isDead?.());
    return hazards.every(npc => {
        const hazard = loc(npc);
        const initialDistance = distance(from, hazard), reach = NpcAggro.aggroRadius(npc) + ROUTE_TOLERANCE;
        const clearance = initialDistance < reach && visibleFrom(hazard, from) ? initialDistance : reach;
        if (endpointOnly) return distance(loc(goal), hazard) >= clearance - 1e-6 || !visibleFrom(hazard, loc(goal));
        for (let index = 1; index < waypoints.length; index++) {
            if (segmentExposes(waypoints[index - 1], waypoints[index], hazard, clearance)) return false;
        }
        return true;
    });
}

function rejectedRecently(session, goal) {
    const anchor = loc(session.followPlayerSession.actor);
    session.supportRouteRejections = (session.supportRouteRejections || []).filter(rejection =>
        Date.now() - rejection.at < REJECTED_ROUTE_TTL_MS && distance(anchor, rejection.anchor) <= TARGET_DRIFT);
    return session.supportRouteRejections.some(rejection => distance(goal, rejection.goal) < 32);
}

function selectDestination(session, bot, candidates) {
    return candidates.find(goal => !rejectedRecently(session, goal) &&
        // Geodata may safely go around an intervening mob. The actual route
        // is checked by the native movement guard after the worker replies.
        routeAllowed(session, bot, [goal], goal, { endpointOnly: true })) || null;
}

function followDestination(session, bot, formation) {
    const anchor = loc(session.followPlayerSession.actor);
    return selectDestination(session, bot, [formation, {
        locX: Math.round((formation.locX + anchor.locX) / 2),
        locY: Math.round((formation.locY + anchor.locY) / 2),
        locZ: anchor.locZ
    }, anchor]);
}

function castPosition(from, target, range) {
    const length = Math.hypot(target.locX - from.locX, target.locY - from.locY, target.locZ - from.locZ);
    const fraction = length > 0 ? Math.max(0, length - range) / length : 0;
    return Object.fromEntries(['locX', 'locY', 'locZ'].map(key =>
        [key, Math.round(from[key] + (target[key] - from[key]) * fraction)]));
}

function supportDestination(session, bot, target, castRange) {
    const anchor = loc(session.followPlayerSession.actor);
    const range = Math.max(0, castRange - CAST_RANGE_MARGIN);
    return selectDestination(session, bot, [
        castPosition(loc(bot), loc(target), range),
        castPosition(anchor, loc(target), range)
    ]);
}

function routeGuard(session, bot, destination) {
    const goal = { ...destination };
    return (route, options) => {
        if (routeAllowed(session, bot, route, goal, options)) return true;
        if (session.followPlayerSession?.actor) {
            session.supportRouteRejections = [...(session.supportRouteRejections || []), {
                goal, anchor: loc(session.followPlayerSession.actor), at: Date.now()
            }].slice(-3);
        }
        return false;
    };
}

module.exports = { PARTY_RADIUS, TARGET_DRIFT, followDestination, supportDestination, routeGuard };
