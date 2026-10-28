const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Slots = invoke('GameServer/Bot/AI/TownNpcSlots');
const InteractionGeometry = invoke('GameServer/Geodata/NpcInteractionGeometry');

const STAGING_DISTANCE = 240;
const INTERACTION_DISTANCE = 72;
const STAGING_ARRIVAL_RADIUS = 64;
// The pathfinder must reach the visible side of a counter before it considers
// the route complete. Keep this tighter than the conversational tolerance: a
// larger goal radius can stop just around a shop wall with no line of sight.
const INTERACTION_ARRIVAL_RADIUS = 16;
const STAGING_READY_RADIUS = 80;
const COUNTER_RESERVATION_DISTANCE = 240;
// Give bots a little room to interact without micro-adjusting at the counter.
// Line of sight and the 300-unit hard cap still guard interaction.
const INTERACTION_READY_RADIUS = 48;
const OPEN_INTERACTION_READY_RADIUS = 144;
const OPEN_APPROACH_SPREAD_STEPS = 9;
const OPEN_APPROACH_SPREAD_ANGLE = Math.PI / 12;
const MAX_INTERACTION_DISTANCE = 300;
const INTERACTION_SEARCH_DISTANCES = Object.freeze([INTERACTION_DISTANCE, 48, 32]);
const COUNTER_SEARCH_DISTANCES = Object.freeze([INTERACTION_DISTANCE, 96, 120, 48, 32]);
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

// A blocked NSWE edge is opaque unless matching client collision triangles
// independently prove a clear conversation ray over the counter.
function hasInteractionLineOfSight(from, to) {
    if (hasLineOfSight(from, to)) return true;
    if (!from || !to || distance2d(from, to) > 144
        || Math.abs(from.locZ - to.locZ) > 16
        || !GeodataEngine.hasGeo(from.locX, from.locY)
        || !GeodataEngine.hasGeo(to.locX, to.locY)) return false;
    const steps = Math.max(1, Math.ceil(distance2d(from, to) / 4));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.locX + (to.locX - from.locX) * t;
        const y = from.locY + (to.locY - from.locY) * t;
        const z = from.locZ + (to.locZ - from.locZ) * t;
        const region = `${(x >> 15) + 20}_${(y >> 15) + 18}`;
        if (GeodataEngine.checkVirtualObstacles(x, y, region)) return false;
        const floor = GeodataEngine.getCellData(x, y, z).z;
        if (floor >= z + 48 || floor < z - 64) return false;
    }
    return InteractionGeometry.canSee(from, to);
}

// An NPC actor as an approach target (the shape plan() and pointsFor() take).
function npcTarget(npc) {
    return { ...pointOf(npc), npcSelfId: Number(npc?.fetchSelfId?.() || 0), head: npc?.fetchHead?.() };
}

// The one rule for "an actor here can talk to this NPC" (plan(), smiths, clan hall managers): in reach, on the
// NPC's floor, and the NPC seen directly, across a low counter, or from the validated counter edge. Shop counters
// often end on the next geodata cell: A* can reach the cell beside a validated front-side interaction point while
// sight from that cell still clips the counter edge; only that tight final gap is accepted.
function canInteract(from, target, points = null) {
    if (!from || !target || distance2d(from, target) > MAX_INTERACTION_DISTANCE
        || Math.abs(Number(from.locZ) - Number(target.locZ)) > 64) return false;
    if (hasInteractionLineOfSight(from, target)) return true;
    const interaction = (points || pointsFor(target))?.interaction;
    return !!interaction && distance2d(from, interaction) <= INTERACTION_ARRIVAL_RADIUS
        && hasInteractionLineOfSight(interaction, target);
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

    let visibleFallback = null;
    for (const distance of COUNTER_SEARCH_DISTANCES) {
        for (const angleOffset of SEARCH_OFFSETS) {
            const interaction = projectedPoint(target, distance, angleOffset);
            if (!hasInteractionLineOfSight(interaction, target)) continue;
            const staging = projectedPoint(target, STAGING_DISTANCE, angleOffset);
            visibleFallback ||= { staging: Object.freeze({ ...staging }), interaction: Object.freeze({ ...interaction }) };
            // Visibility alone can select a roof or a disconnected counter side.
            const stagingZ = GeodataEngine.getHeight(staging.locX, staging.locY, staging.locZ);
            if (Math.abs(stagingZ - staging.locZ) > 64) continue;
            staging.locZ = stagingZ;
            if (!reachableCounterSlot(staging, interaction)) continue;
            return cachePoints(key, Object.freeze({
                staging: Object.freeze(staging),
                interaction: Object.freeze(interaction)
            }));
        }
    }

    if (visibleFallback) {
        // Seen but no reachable counter slot: bots walk to a point A* may not reach (T49 live read).
        utils.infoWarn('TownNpcApproach', 'npc %d at %d,%d: no reachable counter slot, visible fallback',
            Number(target.npcSelfId), Math.round(Number(target.locX)), Math.round(Number(target.locY)));
        return cachePoints(key, Object.freeze(visibleFallback));
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

function openSlotsFor(target, fallback) {
    const candidates = [];
    for (let step = 0; step < 8; step++) {
        const interaction = radialPoint(target, INTERACTION_DISTANCE, step * Math.PI / 4);
        if (hasLineOfSight(interaction, target)) candidates.push(interaction);
    }
    return candidates.length ? candidates : [fallback];
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
    const key = targetKey(kind, target);
    let state = session?.townNpcApproach;
    if (state?.key !== key) {
        Slots.release(session);
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

    // Everyone can walk to the shop in parallel. Reserve its scarce counter
    // places only for the short final approach, after reaching the public side.
    const nearCounter = state.phase === 'interaction'
        && distance2d(botPoint, points.interaction) <= COUNTER_RESERVATION_DISTANCE
        && Math.abs(botPoint.locZ - points.interaction.locZ) <= 64;
    if (session && actorId && nearCounter) {
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
                if (hasInteractionLineOfSight(interaction, target) && hasLineOfSight(base.interaction, interaction)
                    && hasLineOfSight(base.staging, staging)
                    && reachableCounterSlot(staging, interaction)) candidates.push({ interaction, staging });
            }
            return candidates;
        }, distance2d(botPoint, base.interaction) <= INTERACTION_READY_RADIUS ? 0 : actorId);
        if (!points) return { ready: false, waiting: true };
    } else Slots.release(session);

    const ready = state.phase === 'interaction'
        && distance2d(botPoint, points.interaction) <= INTERACTION_READY_RADIUS
        && Math.abs(botPoint.locZ - points.interaction.locZ) <= 64
        && canInteract(botPoint, target, points);
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
        const preferredPoint = openPointFor(target, bot);
        const candidates = openSlotsFor(target, preferredPoint);
        const preferred = candidates.reduce((best, point, index) =>
            distance2d(point, preferredPoint) < distance2d(candidates[best], preferredPoint) ? index : best, 0);
        state = {
            key,
            phase: 'interaction',
            destination: candidates[preferred],
            preferred,
            readyOnEntry: distance2d(botPoint, target) <= OPEN_INTERACTION_READY_RADIUS
                && Math.abs(botPoint.locZ - Number(target.locZ)) <= 64 && hasLineOfSight(botPoint, target)
        };
        if (session) {
            session.townNpcApproach = state;
            session.townRoutePlan = null;
            delete session.companionNavigationRecovery;
        }
    }

    const nearNpc = distance2d(botPoint, target) <= COUNTER_RESERVATION_DISTANCE
        && Math.abs(botPoint.locZ - Number(target.locZ)) <= 64;
    if (!state.readyOnEntry && session && Number(bot?.fetchId?.() || 0) && nearNpc) {
        const assigned = Slots.reserve(session, `open:${pointCacheKey(target)}`,
            () => openSlotsFor(target, state.destination), state.preferred ?? Math.abs(Number(bot.fetchId())));
        if (!assigned) return { ready: false, waiting: true };
        state.destination = assigned;
    } else Slots.release(session);
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
    COUNTER_RESERVATION_DISTANCE,
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
    hasInteractionLineOfSight,
    canInteract,
    npcTarget,
    pointOf,
    plan,
    planOpen,
    openPointFor,
    pointsFor,
    projectedPoint,
    reset,
    skipStaging,
    targetKey
};
