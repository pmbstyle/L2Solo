const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const STAGING_DISTANCE = 240;
const INTERACTION_DISTANCE = 72;
const STAGING_ARRIVAL_RADIUS = 64;
// The pathfinder must reach the visible side of a counter before it considers
// the route complete. Keep this tighter than the conversational tolerance: a
// larger goal radius can stop just around a shop wall with no line of sight.
const INTERACTION_ARRIVAL_RADIUS = 16;
const STAGING_READY_RADIUS = 80;
// Give bots a little room to interact without micro-adjusting at the counter.
// Line of sight and the 300-unit hard cap still guard interaction.
const INTERACTION_READY_RADIUS = 48;
const OPEN_INTERACTION_READY_RADIUS = 144;
const OPEN_APPROACH_SPREAD_STEPS = 9;
const OPEN_APPROACH_SPREAD_ANGLE = Math.PI / 12;
const MAX_INTERACTION_DISTANCE = 300;
const INTERACTION_SEARCH_DISTANCES = Object.freeze([INTERACTION_DISTANCE, 48, 32]);
const INTERACTION_SEARCH_STEPS = 32;
const POINT_CACHE_LIMIT = 256;

// Exact door captures can be added here when an NPC's spawn heading does not
// point through the public entrance. Most C4 town NPCs already face the player
// side of their counter, so the generic heading-derived points are enough.
const APPROACH_OVERRIDES = Object.freeze({});
const pointCache = new Map();

function pointOf(actor) {
    return {
        locX: Number(actor?.fetchLocX?.() ?? actor?.locX ?? 0),
        locY: Number(actor?.fetchLocY?.() ?? actor?.locY ?? 0),
        locZ: Number(actor?.fetchLocZ?.() ?? actor?.locZ ?? 0)
    };
}

function distance2d(first, second) {
    return Math.hypot(
        Number(first?.locX || 0) - Number(second?.locX || 0),
        Number(first?.locY || 0) - Number(second?.locY || 0)
    );
}

function normalizedHeading(target) {
    if (target?.head === null || target?.head === undefined) return null;
    const head = Number(target.head);
    if (!Number.isFinite(head)) return null;
    return ((head % 65536) + 65536) % 65536;
}

function projectedPoint(target, distance, angleOffset = 0) {
    const head = normalizedHeading(target);
    if (head === null) return null;
    const radians = (head / 65536) * Math.PI * 2 + angleOffset;
    return {
        locX: Math.round(Number(target.locX) + Math.cos(radians) * distance),
        locY: Math.round(Number(target.locY) + Math.sin(radians) * distance),
        locZ: Number(target.locZ)
    };
}

function radialPoint(target, distance, radians) {
    return {
        locX: Math.round(Number(target.locX) + Math.cos(radians) * distance),
        locY: Math.round(Number(target.locY) + Math.sin(radians) * distance),
        locZ: Number(target.locZ)
    };
}

function hasLineOfSight(from, to) {
    if (!from || !to) return false;
    return GeodataEngine.hasLineOfSight(
        Number(from.locX), Number(from.locY), Number(from.locZ),
        Number(to.locX), Number(to.locY), Number(to.locZ)
    );
}

function angularOffsets() {
    const offsets = [0];
    for (let step = 1; step <= INTERACTION_SEARCH_STEPS / 2; step++) {
        const angle = (Math.PI * 2 * step) / INTERACTION_SEARCH_STEPS;
        offsets.push(angle);
        if (step < INTERACTION_SEARCH_STEPS / 2) offsets.push(-angle);
    }
    return offsets;
}

const SEARCH_OFFSETS = Object.freeze(angularOffsets());

function pointCacheKey(target) {
    return [
        Number(target?.npcSelfId || 0),
        Math.round(Number(target?.locX || 0)),
        Math.round(Number(target?.locY || 0)),
        Math.round(Number(target?.locZ || 0)),
        normalizedHeading(target) ?? 'none'
    ].join(':');
}

function cachePoints(key, points) {
    if (pointCache.size >= POINT_CACHE_LIMIT) pointCache.delete(pointCache.keys().next().value);
    pointCache.set(key, points);
    return points;
}

function pointsFor(target) {
    if (!target?.npcSelfId || normalizedHeading(target) === null) return null;
    const override = APPROACH_OVERRIDES[Number(target.npcSelfId)] || null;
    if (override) {
        return {
            staging: override.staging ? { ...override.staging } : projectedPoint(target, STAGING_DISTANCE),
            interaction: override.interaction ? { ...override.interaction } : projectedPoint(target, INTERACTION_DISTANCE)
        };
    }

    const key = pointCacheKey(target);
    const cached = pointCache.get(key);
    if (cached) return cached;

    for (const distance of INTERACTION_SEARCH_DISTANCES) {
        for (const angleOffset of SEARCH_OFFSETS) {
            const interaction = projectedPoint(target, distance, angleOffset);
            if (!hasLineOfSight(interaction, target)) continue;
            return cachePoints(key, Object.freeze({
                staging: Object.freeze(projectedPoint(target, STAGING_DISTANCE, angleOffset)),
                interaction: Object.freeze(interaction)
            }));
        }
    }

    return cachePoints(key, Object.freeze({
        staging: Object.freeze(projectedPoint(target, STAGING_DISTANCE)),
        interaction: Object.freeze(projectedPoint(target, INTERACTION_DISTANCE))
    }));
}

function openPointFor(target, bot) {
    const botPoint = pointOf(bot);
    const dx = botPoint.locX - Number(target?.locX || 0);
    const dy = botPoint.locY - Number(target?.locY || 0);
    const fallbackHeading = normalizedHeading(target);
    const baseAngle = Math.hypot(dx, dy) > 1
        ? Math.atan2(dy, dx)
        : (fallbackHeading === null ? 0 : (fallbackHeading / 65536) * Math.PI * 2);
    const actorId = Math.abs(Math.trunc(Number(bot?.fetchId?.() ?? bot?.actorId ?? 0)));
    const spreadSlot = (actorId % OPEN_APPROACH_SPREAD_STEPS) - Math.floor(OPEN_APPROACH_SPREAD_STEPS / 2);
    const preferredAngle = baseAngle + spreadSlot * OPEN_APPROACH_SPREAD_ANGLE;

    for (const distance of INTERACTION_SEARCH_DISTANCES) {
        for (const angleOffset of SEARCH_OFFSETS) {
            const interaction = radialPoint(target, distance, preferredAngle + angleOffset);
            if (hasLineOfSight(interaction, target)) return interaction;
        }
    }

    return radialPoint(target, INTERACTION_DISTANCE, preferredAngle);
}

function targetKey(kind, target) {
    return [
        String(kind || 'town_npc'),
        Number(target?.actorId || 0),
        Number(target?.npcSelfId || 0),
        Math.round(Number(target?.locX || 0)),
        Math.round(Number(target?.locY || 0)),
        Math.round(Number(target?.locZ || 0)),
        normalizedHeading(target) ?? 'none'
    ].join(':');
}

function reset(session) {
    if (!session) return;
    delete session.townNpcApproach;
    session.townRoutePlan = null;
}

function skipStaging(session) {
    if (session?.townNpcApproach?.phase !== 'staging') return false;
    session.townNpcApproach.phase = 'interaction';
    session.townRoutePlan = null;
    delete session.companionNavigationRecovery;
    session.lastPathfinding = null;
    return true;
}

function plan(session, bot, target, kind = 'town_npc') {
    const points = pointsFor(target);
    if (!points) return null;

    const botPoint = pointOf(bot);
    const key = targetKey(kind, target);
    let state = session?.townNpcApproach;
    if (state?.key !== key) {
        const alreadyAtFront = distance2d(botPoint, points.interaction) <= INTERACTION_READY_RADIUS
            && distance2d(botPoint, target) <= MAX_INTERACTION_DISTANCE;
        state = { key, phase: alreadyAtFront ? 'interaction' : 'staging' };
        if (session) {
            session.townNpcApproach = state;
            session.townRoutePlan = null;
            delete session.companionNavigationRecovery;
        }
    }

    if (state.phase === 'staging' && distance2d(botPoint, points.staging) <= STAGING_READY_RADIUS) {
        state.phase = 'interaction';
        if (session) {
            session.townRoutePlan = null;
            delete session.companionNavigationRecovery;
        }
    }

    const interactionDistance = distance2d(botPoint, points.interaction);
    const targetVisible = hasLineOfSight(botPoint, target);
    // Shop counters often end on the next geodata cell: A* can reach the cell
    // beside a validated front-side interaction point, while LOS from that
    // cell still clips the counter edge. Accept only that tight final gap;
    // the wider conversational tolerance continues to require direct LOS.
    const reachedValidatedCounterEdge = interactionDistance <= INTERACTION_ARRIVAL_RADIUS
        && hasLineOfSight(points.interaction, target);
    const ready = state.phase === 'interaction'
        && interactionDistance <= INTERACTION_READY_RADIUS
        && distance2d(botPoint, target) <= MAX_INTERACTION_DISTANCE
        && (targetVisible || reachedValidatedCounterEdge);
    const destination = state.phase === 'staging' ? points.staging : points.interaction;

    return {
        ready,
        phase: state.phase,
        destination: {
            ...destination,
            actorId: null,
            npcSelfId: Number(target.npcSelfId),
            name: target.name,
            town: target.town
        },
        arrivalRadius: state.phase === 'staging'
            ? STAGING_ARRIVAL_RADIUS
            : INTERACTION_ARRIVAL_RADIUS,
        points
    };
}

// Open-air NPCs do not need the shared street-side staging waypoint used to
// enter shops. Approach them directly from the bot's side and spread nearby
// bots around the interaction circle so a party does not funnel through one
// artificial coordinate.
function planOpen(session, bot, target, kind = 'town_npc') {
    if (!target || !Number.isFinite(Number(target.locX)) || !Number.isFinite(Number(target.locY))) return null;

    const botPoint = pointOf(bot);
    const key = `${targetKey(kind, target)}:open:${Number(bot?.fetchId?.() ?? bot?.actorId ?? 0)}`;
    let state = session?.townNpcApproach;
    if (state?.key !== key) {
        state = {
            key,
            phase: 'interaction',
            destination: openPointFor(target, bot)
        };
        if (session) {
            session.townNpcApproach = state;
            session.townRoutePlan = null;
            delete session.companionNavigationRecovery;
        }
    }

    const ready = distance2d(botPoint, target) <= OPEN_INTERACTION_READY_RADIUS
        && hasLineOfSight(botPoint, target);

    return {
        ready,
        phase: 'interaction',
        destination: {
            ...state.destination,
            actorId: null,
            npcSelfId: Number(target.npcSelfId || 0),
            name: target.name,
            town: target.town
        },
        arrivalRadius: INTERACTION_ARRIVAL_RADIUS,
        points: { interaction: state.destination }
    };
}

module.exports = {
    APPROACH_OVERRIDES,
    INTERACTION_ARRIVAL_RADIUS,
    INTERACTION_DISTANCE,
    INTERACTION_READY_RADIUS,
    MAX_INTERACTION_DISTANCE,
    OPEN_INTERACTION_READY_RADIUS,
    STAGING_ARRIVAL_RADIUS,
    STAGING_DISTANCE,
    STAGING_READY_RADIUS,
    normalizedHeading,
    hasLineOfSight,
    plan,
    planOpen,
    openPointFor,
    pointsFor,
    projectedPoint,
    reset,
    skipStaging,
    targetKey
};
