const World         = invoke('GameServer/World/World');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const NpcAggro      = invoke('GameServer/Npc/NpcAggro');

const DEFAULT_RETREAT_DISTANCE = 850;
const AGGRO_BUFFER = 120;
const CANDIDATE_ANGLES = [0, -30, 30, -60, 60, -90, 90, -120, 120];

function point(actor) {
    return {
        locX: Number(actor?.fetchLocX?.() ?? actor?.locX ?? 0),
        locY: Number(actor?.fetchLocY?.() ?? actor?.locY ?? 0),
        locZ: Number(actor?.fetchLocZ?.() ?? actor?.locZ ?? 0)
    };
}

function actorId(actor) {
    return actor?.fetchId?.() ?? actor?.id ?? null;
}

function distance2d(first, second) {
    const dx = first.locX - second.locX;
    const dy = first.locY - second.locY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function distanceToSegment(target, from, to) {
    const dx = to.locX - from.locX;
    const dy = to.locY - from.locY;
    const lengthSquared = (dx * dx) + (dy * dy);
    if (lengthSquared <= 0) return distance2d(target, from);

    const projection = Math.max(0, Math.min(1,
        (((target.locX - from.locX) * dx) + ((target.locY - from.locY) * dy)) / lengthSquared
    ));
    return distance2d(target, {
        locX: from.locX + (dx * projection),
        locY: from.locY + (dy * projection)
    });
}

function distanceToRoute(target, from, candidate) {
    if (candidate.lowLodWarp) return distance2d(target, candidate.to);

    const route = [from, ...(candidate.route || [candidate.to])];
    let minimum = Infinity;
    for (let index = 1; index < route.length; index++) {
        minimum = Math.min(minimum, distanceToSegment(target, route[index - 1], route[index]));
    }
    return minimum;
}

function isPotentialAggro(npc, threatId) {
    return actorId(npc) !== threatId &&
        npc?.fetchHostile?.() === true &&
        npc?.isDead?.() !== true &&
        npc?.state?.fetchDead?.() !== true;
}

function rotate(vector, degrees) {
    const radians = degrees * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: (vector.x * cos) - (vector.y * sin),
        y: (vector.x * sin) + (vector.y * cos)
    };
}

function awayVector(from, threat, preferredPoint) {
    let x = from.locX - threat.locX;
    let y = from.locY - threat.locY;
    let magnitude = Math.sqrt((x * x) + (y * y));

    if (magnitude < 1 && preferredPoint) {
        x = preferredPoint.locX - threat.locX;
        y = preferredPoint.locY - threat.locY;
        magnitude = Math.sqrt((x * x) + (y * y));
    }
    if (magnitude < 1) {
        x = 1;
        y = 0;
        magnitude = 1;
    }

    return { x: x / magnitude, y: y / magnitude };
}

function directRouteUsable(geodata, from, to) {
    try {
        return geodata.hasLineOfSight(
            from.locX, from.locY, from.locZ,
            to.locX, to.locY, to.locZ
        ) === true;
    } catch (_) {
        return false;
    }
}

function groundHeight(geodata, to, fallbackZ) {
    try {
        return geodata.getHeight(to.locX, to.locY, fallbackZ);
    } catch (_) {
        return fallbackZ;
    }
}

function routeCandidate(options, geodata, from, requestedTo) {
    if (typeof options.previewRoute === 'function') {
        try {
            const diagnostics = options.previewRoute(from, requestedTo);
            if (diagnostics) {
                const routedTo = point(diagnostics.routedTo || requestedTo);
                return {
                    requestedTo,
                    to: routedTo,
                    route: Array.isArray(diagnostics.route)
                        ? diagnostics.route.map((waypoint) => point(waypoint))
                        : [routedTo],
                    routeUsable: diagnostics.routeUsable === true,
                    lowLodWarp: diagnostics.lowLodWarp === true,
                    routeStrategy: diagnostics.strategy || null
                };
            }
        } catch (_) {
            // Fall back to a direct geodata check when preview diagnostics are
            // unavailable. The actual retreat command remains best-effort.
        }
    }

    return {
        requestedTo,
        to: requestedTo,
        route: [from, requestedTo],
        routeUsable: directRouteUsable(geodata, from, requestedTo),
        lowLodWarp: false,
        routeStrategy: 'direct_los_fallback'
    };
}

function evaluateCandidate(candidate, from, threat, hazards, aggroRadius) {
    let newAggroCount = 0;
    let endpointAggroCount = 0;
    let bufferIntrusionCount = 0;
    let approachingHazardCount = 0;
    let minimumEndpointClearance = Infinity;

    hazards.forEach((npc) => {
        const hazard = point(npc);
        const startDistance = distance2d(from, hazard);
        const endpointDistance = distance2d(candidate.to, hazard);
        const routeDistance = distanceToRoute(hazard, from, candidate);

        if (startDistance > aggroRadius && routeDistance <= aggroRadius) newAggroCount++;
        if (endpointDistance <= aggroRadius) endpointAggroCount++;
        if (startDistance > aggroRadius + AGGRO_BUFFER && routeDistance <= aggroRadius + AGGRO_BUFFER) {
            bufferIntrusionCount++;
        }
        if (endpointDistance + AGGRO_BUFFER < startDistance) approachingHazardCount++;
        minimumEndpointClearance = Math.min(minimumEndpointClearance, endpointDistance);
    });

    const initialThreatDistance = distance2d(from, threat);
    const threatDistance = distance2d(candidate.to, threat);
    const minimumThreatDistance = distanceToRoute(threat, from, candidate);
    const movesAway = threatDistance > initialThreatDistance &&
        minimumThreatDistance >= initialThreatDistance - 1;
    return {
        ...candidate,
        newAggroCount,
        endpointAggroCount,
        bufferIntrusionCount,
        approachingHazardCount,
        minimumEndpointClearance,
        threatDistance,
        minimumThreatDistance,
        movesAway,
        safe: movesAway && candidate.routeUsable && newAggroCount === 0 && endpointAggroCount === 0 && bufferIntrusionCount === 0
    };
}

function compareCandidates(first, second) {
    return Number(second.movesAway) - Number(first.movesAway) ||
        Number(second.routeUsable) - Number(first.routeUsable) ||
        first.newAggroCount - second.newAggroCount ||
        first.endpointAggroCount - second.endpointAggroCount ||
        first.bufferIntrusionCount - second.bufferIntrusionCount ||
        first.approachingHazardCount - second.approachingHazardCount ||
        first.angleRank - second.angleRank ||
        second.minimumEndpointClearance - first.minimumEndpointClearance ||
        second.threatDistance - first.threatDistance;
}

function plan(bot, threatActor, options = {}) {
    const world = options.world || World;
    const geodata = options.geodata || GeodataEngine;
    const distance = Math.max(100, Number(options.distance || DEFAULT_RETREAT_DISTANCE));
    const from = point(bot);
    const threat = point(threatActor);
    const threatId = actorId(threatActor);
    const preferredPoint = options.preferredPoint ? point(options.preferredPoint) : null;
    const direction = awayVector(from, threat, preferredPoint);
    const aggroRadius = Number(options.aggroRadius || NpcAggro.AGGRO_RADIUS);
    const searchRadius = distance + aggroRadius + AGGRO_BUFFER;
    const hazards = (world.fetchNpcsInRadius?.(from.locX, from.locY, searchRadius) || [])
        .filter((npc) => isPotentialAggro(npc, threatId));

    const evaluatedCandidates = [];
    for (let angleRank = 0; angleRank < CANDIDATE_ANGLES.length; angleRank++) {
        const angle = CANDIDATE_ANGLES[angleRank];
        const rotated = rotate(direction, angle);
        const destination = {
            locX: Math.round(from.locX + (rotated.x * distance)),
            locY: Math.round(from.locY + (rotated.y * distance)),
            locZ: from.locZ
        };
        destination.locZ = groundHeight(geodata, destination, from.locZ);
        const candidate = evaluateCandidate({
            angle,
            angleRank,
            ...routeCandidate(options, geodata, from, destination)
        }, from, threat, hazards, aggroRadius);
        evaluatedCandidates.push(candidate);
        // Angles are ordered by tactical preference. Once a fully safe route
        // is found, later previews cannot improve any safety dimension and
        // would only multiply bounded A* work during population spikes.
        if (candidate.safe) break;
    }

    const candidates = evaluatedCandidates.sort(compareCandidates);
    const selected = candidates[0];
    return {
        from,
        to: selected.to,
        requestedTo: selected.requestedTo,
        threatId,
        distance,
        selectedAngle: selected.angle,
        movesAway: selected.movesAway,
        emergencyFallback: !selected.movesAway,
        routeUsable: selected.routeUsable,
        routeStrategy: selected.routeStrategy,
        safe: selected.safe,
        hazardCount: hazards.length,
        newAggroCount: selected.newAggroCount,
        endpointAggroCount: selected.endpointAggroCount,
        bufferIntrusionCount: selected.bufferIntrusionCount,
        minimumEndpointClearance: Number.isFinite(selected.minimumEndpointClearance)
            ? Math.round(selected.minimumEndpointClearance)
            : null,
        candidates: candidates.map((candidate) => ({
            angle: candidate.angle,
            routeUsable: candidate.routeUsable,
            movesAway: candidate.movesAway,
            safe: candidate.safe,
            newAggroCount: candidate.newAggroCount,
            endpointAggroCount: candidate.endpointAggroCount,
            bufferIntrusionCount: candidate.bufferIntrusionCount,
            minimumEndpointClearance: Number.isFinite(candidate.minimumEndpointClearance)
                ? Math.round(candidate.minimumEndpointClearance)
                : null
        }))
    };
}

function retreat(session, bot, threat, options = {}) {
    const planOptions = { ...options };
    if (!planOptions.previewRoute && bot.session === session) {
        planOptions.previewRoute = (from, to) => {
            const previousPathfinding = session.lastPathfinding;
            const previousTownRoute = session.townRoutePlan;
            try {
                return bot.moveTo({ from: { ...from }, to: { ...to }, previewOnly: true });
            } finally {
                session.lastPathfinding = previousPathfinding;
                session.townRoutePlan = previousTownRoute;
            }
        };
    }

    const result = plan(bot, threat, planOptions);
    session.lastRetreatPlan = {
        ...result,
        from: { ...result.from },
        to: { ...result.to },
        candidates: result.candidates.map((candidate) => ({ ...candidate })),
        at: Date.now()
    };
    bot.moveTo({ from: result.from, to: { ...result.requestedTo } });
    return result;
}

module.exports = {
    AGGRO_BUFFER,
    CANDIDATE_ANGLES,
    DEFAULT_RETREAT_DISTANCE,
    distanceToSegment,
    plan,
    retreat
};
