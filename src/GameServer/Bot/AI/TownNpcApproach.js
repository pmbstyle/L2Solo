const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Slots = invoke('GameServer/Bot/AI/TownNpcSlots');

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

function reachableCounterSlot(staging, interaction) {
    // NPC visibility may start inside the counter. Validate the actual A*
    // arrival cells from the accessible staging side, not from that endpoint.
    const cx = interaction.locX >> 4, cy = interaction.locY >> 4;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const point = { locX: ((cx + dx) << 4) + 8, locY: ((cy + dy) << 4) + 8, locZ: interaction.locZ };
        if (distance2d(point, interaction) > INTERACTION_ARRIVAL_RADIUS) continue;
        point.locZ = GeodataEngine.getHeight(point.locX, point.locY, point.locZ);
        if (Math.abs(point.locZ - interaction.locZ) <= 64 && hasLineOfSight(staging, point)) return true;
    }
    return false;
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
        GeodataEngine.navigationRevision || 0,
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
    Slots.release(session);
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
    let points = pointsFor(target);
    if (!points) return null;

    const botPoint = pointOf(bot);
    const actorId = Number(bot?.fetchId?.() || 0);
    if (session?.townNpcSlot && session.townNpcSlot.key !== `counter:${pointCacheKey(target)}`) Slots.release(session);
    if (session && actorId && distance2d(botPoint, points.interaction) > INTERACTION_READY_RADIUS) {
        const base = points;
        points = Slots.reserve(session, `counter:${pointCacheKey(target)}`, () => {
            const dx = base.interaction.locX - target.locX, dy = base.interaction.locY - target.locY;
            const length = Math.hypot(dx, dy) || 1;
            const candidates = [base];
            for (const offset of [-80, -40, 40, 80]) {
                const shift = (point) => ({
                    locX: Math.round(point.locX - dy / length * offset),
                    locY: Math.round(point.locY + dx / length * offset), locZ: point.locZ
                });
                const interaction = shift(base.interaction), staging = shift(base.staging);
                if (hasLineOfSight(interaction, target) && hasLineOfSight(base.interaction, interaction)
                    && hasLineOfSight(base.staging, staging)
                    && reachableCounterSlot(staging, interaction)) candidates.push({ interaction, staging });
            }
            return candidates;
        }, actorId);
        if (!points) return { ready: false, waiting: true };
    } else if (session?.townNpcSlot?.key === `counter:${pointCacheKey(target)}`) {
        // Keep the leased point authoritative through the last few steps.
        points = Slots.reserve(session, session.townNpcSlot.key, () => [points], actorId) || points;
    }
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
        && Math.abs(botPoint.locZ - points.interaction.locZ) <= 64
        && Math.abs(botPoint.locZ - Number(target.locZ)) <= 64
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
        Slots.release(session);
        state = {
            key,
            phase: 'interaction',
            destination: openPointFor(target, bot),
            readyOnEntry: distance2d(botPoint, target) <= OPEN_INTERACTION_READY_RADIUS
                && Math.abs(botPoint.locZ - Number(target.locZ)) <= 64 && hasLineOfSight(botPoint, target)
        };
        if (session) {
            session.townNpcApproach = state;
            session.townRoutePlan = null;
            delete session.companionNavigationRecovery;
        }
    }

    if (!state.readyOnEntry && session && Number(bot?.fetchId?.() || 0)) {
        const assigned = Slots.reserve(session, `open:${pointCacheKey(target)}`, () => {
            const candidates = [];
            for (let step = 0; step < 8; step++) {
                const interaction = radialPoint(target, INTERACTION_DISTANCE, step * Math.PI / 4);
                if (hasLineOfSight(interaction, target)) candidates.push(interaction);
            }
            return candidates.length ? candidates : [state.destination];
        }, Math.abs(Number(bot.fetchId())));
        if (!assigned) return { ready: false, waiting: true };
        state.destination = assigned;
    }
    const ready = distance2d(botPoint, target) <= OPEN_INTERACTION_READY_RADIUS
        && Math.abs(botPoint.locZ - Number(target.locZ)) <= 64
        && (state.readyOnEntry || !session?.townNpcSlot || distance2d(botPoint, state.destination) <= 32)
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
