const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const InteractionGeometry = invoke('GameServer/Geodata/NpcInteractionGeometry');

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
const OPEN_ARRIVAL_CHECK_RADIUS = 32;
const OPEN_APPROACH_SPREAD_STEPS = 9;
const OPEN_APPROACH_SPREAD_ANGLE = Math.PI / 12;
const MAX_INTERACTION_DISTANCE = 300;
const INTERACTION_SEARCH_DISTANCES = Object.freeze([INTERACTION_DISTANCE, 48, 32]);
const COUNTER_SEARCH_DISTANCES = Object.freeze([INTERACTION_DISTANCE, 96, 120, 48, 32]);
const INTERACTION_SEARCH_STEPS = 32;
const POINT_CACHE_LIMIT = 256;
// Talking places on a counter front are spread this far apart, and a body within TALK_POINT_GAP of a place
// makes it taken for the next bot that picks (two bodies in one model are what a player sees as a stack).
const FRONT_STEP = 24;
const FRONT_SIDE_STEPS = 4;
const TALK_POINT_GAP = 16;
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

// A point to talk to an NPC from stands on the floor nearest the NPC's z, and is none when that floor is more than
// 64 from the NPC's (a pillar or roof top over the NPC): the rule canInteract applies to the actor.
function onNpcFloor(point, target) {
    const z = GeodataEngine.getHeight(point.locX, point.locY, Number(target.locZ));
    return Math.abs(z - Number(target.locZ)) > 64 ? null : { ...point, locZ: z };
}

function hasLineOfSight(from, to) {
    if (!from || !to) return false;
    return GeodataEngine.canWalkStraight(
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
    // Without the caller's own place, any place of the counter front is a validated arrival point.
    const places = points ? [points.interaction] : (pointsFor(target)?.front || []);
    return places.some(place => !!place && distance2d(from, place) <= INTERACTION_ARRIVAL_RADIUS
        && hasInteractionLineOfSight(place, target));
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

// The places along the counter front a bot can talk from: the base point first, then points beside it
// (FRONT_STEP apart, at the base distance and one step farther), each on the NPC floor, in reach, seen from the
// NPC, walkable from the base point and reachable from staging. C4 has no exclusive place at a merchant
// (L2Character.canInteract is a radius test), so this is only room for bodies to stand apart.
function frontFor(target, staging, interaction) {
    const dx = interaction.locX - Number(target.locX), dy = interaction.locY - Number(target.locY);
    const length = Math.hypot(dx, dy) || 1;
    const front = [interaction];
    for (const extra of [0, FRONT_STEP]) for (let side = -FRONT_SIDE_STEPS; side <= FRONT_SIDE_STEPS; side++) {
        if (!extra && !side) continue;
        const scale = (length + extra) / length, offset = side * FRONT_STEP;
        const point = onNpcFloor({
            locX: Math.round(Number(target.locX) + dx * scale - dy / length * offset),
            locY: Math.round(Number(target.locY) + dy * scale + dx / length * offset),
            locZ: Number(target.locZ)
        }, target);
        if (point && distance2d(point, target) <= MAX_INTERACTION_DISTANCE
            && hasInteractionLineOfSight(point, target) && hasLineOfSight(interaction, point)
            && reachableCounterSlot(staging, point)) front.push(Object.freeze(point));
    }
    return Object.freeze(front);
}

function pointsFor(target) {
    if (!target?.npcSelfId || normalizedHeading(target) === null) return null;

    const key = pointCacheKey(target);
    const cached = pointCache.get(key);
    if (cached) return cached;

    let visibleFallback = null;
    for (const distance of COUNTER_SEARCH_DISTANCES) {
        for (const angleOffset of SEARCH_OFFSETS) {
            const interaction = onNpcFloor(projectedPoint(target, distance, angleOffset), target);
            if (!interaction || !hasInteractionLineOfSight(interaction, target)) continue;
            const staging = projectedPoint(target, STAGING_DISTANCE, angleOffset);
            visibleFallback ||= {
                staging: Object.freeze({ ...staging }), interaction: Object.freeze({ ...interaction }),
                front: Object.freeze([Object.freeze({ ...interaction })])
            };
            // Visibility alone can select a roof or a disconnected counter side.
            const stagingZ = GeodataEngine.getHeight(staging.locX, staging.locY, staging.locZ);
            if (Math.abs(stagingZ - staging.locZ) > 64) continue;
            staging.locZ = stagingZ;
            if (!reachableCounterSlot(staging, interaction)) continue;
            return cachePoints(key, Object.freeze({
                staging: Object.freeze(staging),
                interaction: Object.freeze(interaction),
                front: frontFor(target, staging, interaction)
            }));
        }
    }

    if (visibleFallback) {
        // Seen but no reachable counter slot: bots walk to a point A* may not reach.
        utils.infoWarn('TownNpcApproach', 'npc %d at %d,%d: no reachable counter slot, visible fallback',
            Number(target.npcSelfId), Math.round(Number(target.locX)), Math.round(Number(target.locY)));
        return cachePoints(key, Object.freeze(visibleFallback));
    }
    const raw = Object.freeze(projectedPoint(target, INTERACTION_DISTANCE));
    return cachePoints(key, Object.freeze({
        staging: Object.freeze(projectedPoint(target, STAGING_DISTANCE)),
        interaction: raw,
        front: Object.freeze([raw])
    }));
}

// The first point from startIndex on, in index order, with no occupied body (plain {locX, locY}) within
// TALK_POINT_GAP; all occupied, the start point. The one pick for counter places and open-air places, hot and cold.
function freePoint(points, startIndex, occupied = []) {
    if (!points?.length) return null;
    const start = Math.abs(Math.trunc(Number(startIndex) || 0)) % points.length;
    for (let i = 0; i < points.length; i++) {
        const point = points[(start + i) % points.length];
        if (!occupied.some(body => distance2d(body, point) <= TALK_POINT_GAP)) return point;
    }
    return points[start];
}

// Where this bot talks to this NPC from: its own place on the counter front (actorId picks the start), moved
// on to the next place when `occupied` bodies stand on it. Hot plan() and cold travel (which passes no bodies).
function talkPointFor(target, actorId, occupied = []) {
    return freePoint(pointsFor(target)?.front, actorId, occupied);
}

// True when a body with a lower actor id stands on the point: of two bots on one point the higher id moves.
function yieldsPoint(bodies, point, actorId) {
    return bodies.some(body => distance2d(body, point) <= TALK_POINT_GAP && Number(body.actorId) < actorId);
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
            const interaction = onNpcFloor(radialPoint(target, distance, preferredAngle + angleOffset), target);
            if (interaction && hasLineOfSight(interaction, target)) return interaction;
        }
    }

    return radialPoint(target, INTERACTION_DISTANCE, preferredAngle);
}

// The places around an open-air NPC a bot is sent to (on its floor, in sight) and the one nearest its own bearing
// point to start from, so a route to it exists (a free bearing point can stand on a pillar or roof top).
function openStart(slots, preferred) {
    let best = 0;
    slots.forEach((point, index) => {
        if (distance2d(point, preferred) < distance2d(slots[best], preferred)) best = index;
    });
    return best;
}

function openSlotsFor(target, fallback) {
    const candidates = [];
    for (let step = 0; step < 8; step++) {
        const interaction = onNpcFloor(radialPoint(target, INTERACTION_DISTANCE, step * Math.PI / 4), target);
        if (interaction && hasLineOfSight(interaction, target)) candidates.push(interaction);
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

// options.bodiesNear(target) -> plain {locX, locY, actorId} of the other bodies near the NPC, asked only when a
// place is picked or checked; none given, the pick sees no bodies.
function plan(session, bot, target, kind = 'town_npc', options = {}) {
    const points = pointsFor(target);
    if (!points) return null;

    const botPoint = pointOf(bot);
    const actorId = Number(bot?.fetchId?.() || 0);
    const key = targetKey(kind, target);
    let state = session?.townNpcApproach;
    if (state?.key !== key) {
        // A bot already standing on a place of the counter front keeps it.
        const standing = points.front.filter(point => distance2d(botPoint, point) <= INTERACTION_READY_RADIUS
            && distance2d(botPoint, target) <= MAX_INTERACTION_DISTANCE)
            .sort((a, b) => distance2d(botPoint, a) - distance2d(botPoint, b))[0] || null;
        state = { key, phase: standing ? 'interaction' : 'staging', ...(standing && { talkPoint: standing }) };
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

    // The bot picks its place on the counter front once, when it turns to the counter, and holds it.
    if (state.phase === 'interaction' && !state.talkPoint) {
        state.talkPoint = talkPointFor(target, actorId, options.bodiesNear?.(target) || []) || points.interaction;
    }
    // On reaching its place, a bot with another body of a lower id on it picks again with the bodies now there.
    if (state.phase === 'interaction' && state.talkPoint && state.checkedPoint !== state.talkPoint
        && distance2d(botPoint, state.talkPoint) <= INTERACTION_READY_RADIUS) {
        state.checkedPoint = state.talkPoint;
        const bodies = options.bodiesNear?.(target) || [];
        if (yieldsPoint(bodies, state.talkPoint, actorId)) {
            state.talkPoint = talkPointFor(target, actorId, bodies) || state.talkPoint;
        }
    }
    const own = state.talkPoint || points.interaction;

    const ready = state.phase === 'interaction'
        && distance2d(botPoint, own) <= INTERACTION_READY_RADIUS
        && Math.abs(botPoint.locZ - own.locZ) <= 64
        && canInteract(botPoint, target, { interaction: own });
    const destination = state.phase === 'staging' ? points.staging : own;

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
        points: { staging: points.staging, interaction: own }
    };
}

// Open-air NPCs do not need the shared street-side staging waypoint used to
// enter shops. Approach them directly from the bot's side and spread nearby
// bots around the interaction circle so a party does not funnel through one
// artificial coordinate.
function planOpen(session, bot, target, kind = 'town_npc', options = {}) {
    if (!target || !Number.isFinite(Number(target.locX)) || !Number.isFinite(Number(target.locY))) return null;

    const botPoint = pointOf(bot);
    const key = `${targetKey(kind, target)}:open:${Number(bot?.fetchId?.() ?? bot?.actorId ?? 0)}`;
    let state = session?.townNpcApproach;
    if (state?.key !== key) {
        const preferred = openPointFor(target, bot);
        const slots = openSlotsFor(target, preferred);
        const slotIndex = openStart(slots, preferred);
        const destination = freePoint([...slots.slice(slotIndex), ...slots.slice(0, slotIndex)], 0,
            options.bodiesNear?.(target) || []);
        state = {
            key,
            phase: 'interaction',
            slots,
            destination,
            readyOnEntry: distance2d(botPoint, target) <= OPEN_INTERACTION_READY_RADIUS
                && Math.abs(botPoint.locZ - Number(target.locZ)) <= 64 && hasLineOfSight(botPoint, target)
        };
        if (session) {
            session.townNpcApproach = state;
            session.townRoutePlan = null;
            delete session.companionNavigationRecovery;
        }
    }

    // On reaching its place, a bot with another body of a lower id on it picks again with the bodies now there.
    if (state.slots && !state.checked && distance2d(botPoint, state.destination) <= OPEN_ARRIVAL_CHECK_RADIUS) {
        state.checked = true;
        const bodies = options.bodiesNear?.(target) || [];
        if (yieldsPoint(bodies, state.destination, Number(bot?.fetchId?.() ?? bot?.actorId ?? 0))) {
            const held = state.slots.indexOf(state.destination);
            const next = freePoint([...state.slots.slice(held), ...state.slots.slice(0, held)], 0, bodies);
            if (next !== state.destination) { state.destination = next; state.checked = false; }
        }
    }

    const ready = distance2d(botPoint, target) <= OPEN_INTERACTION_READY_RADIUS
        && Math.abs(botPoint.locZ - Number(target.locZ)) <= 64
        && (state.readyOnEntry || distance2d(botPoint, state.destination) <= 32)
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
    freePoint,
    npcTarget,
    pointOf,
    plan,
    planOpen,
    openPointFor,
    pointsFor,
    projectedPoint,
    reset,
    skipStaging,
    talkPointFor,
    targetKey
};
