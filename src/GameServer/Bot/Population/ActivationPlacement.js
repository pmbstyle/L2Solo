const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');

// A walker shown on its road (HotActivation) stands within ROAD_RADIUS of its road
// point; a point off the ground is stepped back toward the run's start in at most
// ROAD_STEPS equal steps, the last one the start itself (a teleport point or where it
// set out). Our choice: the run is a straight line until roads exist.
const ROAD_RADIUS = 300;
const ROAD_STEPS = 12;

function finiteLocation(loc) {
    return !!loc && ['locX', 'locY', 'locZ'].every((key) =>
        loc[key] !== null && loc[key] !== undefined && String(loc[key]).trim() !== ''
        && Number.isFinite(Number(loc[key])));
}

function distance(a, b) {
    return Math.hypot(a.locX - b.locX, a.locY - b.locY);
}

function surface(loc) {
    if (!finiteLocation(loc)) return null;
    // getCellData loads the region; hasGeo alone only checks the loaded cache.
    const cell = Geo.getCellData(Number(loc.locX), Number(loc.locY), Number(loc.locZ));
    if (!Geo.hasGeo(Number(loc.locX), Number(loc.locY)) || !cell.nswe
        || !Number.isFinite(cell.z) || Math.abs(cell.z - Number(loc.locZ)) > 64) return null;
    return { locX: Number(loc.locX), locY: Number(loc.locY), locZ: cell.z };
}

function connected(from, to) {
    // The movement ray checks reciprocal NSWE, corner cutting, layer steps
    // and arrival on the requested floor, including virtual obstacles.
    return Geo.hasLineOfSight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ);
}

function clearSurface(loc) {
    const center = surface(loc);
    if (!center) return null;
    // Leave one geodata cell of room around the actor, rather than accepting
    // a point pressed into a wall or inside a blocked cell.
    for (const [dx, dy] of [[16, 0], [-16, 0], [0, 16], [0, -16]]) {
        const edge = surface({ locX: center.locX + dx, locY: center.locY + dy, locZ: center.locZ });
        if (!edge || !connected(center, edge)) return null;
    }
    return center;
}

function raidSurface(loc) {
    if (!finiteLocation(loc)) return null;
    const z = Geo.getHeight(loc.locX, loc.locY, loc.locZ);
    // C4 raid spawn Z can sit above the terrain. Ground only downward,
    // within the raid's existing 500-unit floor tolerance; never onto a roof.
    if (z > Number(loc.locZ) + 64 || Number(loc.locZ) - z > 500) return null;
    return surface({ ...loc, locZ: z });
}

function grounded(locX, locY, locZ) {
    locX = Math.round(locX);
    locY = Math.round(locY);
    return surface({ locX, locY, locZ: Geo.getHeight(locX, locY, Number(locZ)) });
}

// The walkable ground of a walker's road point (ColdTrip.positionAt, a straight-line
// estimate that can sit in rock or water): the point itself, else the first step
// back toward `from` that stands on ground. A step back is counted (walkerRoadStepBacks).
function roadAnchor(loc, from) {
    if (!finiteLocation(loc)) return null;
    const own = grounded(Number(loc.locX), Number(loc.locY), loc.locZ);
    if (own || !finiteLocation(from)) return own;
    for (let i = 1; i <= ROAD_STEPS; i++) {
        const t = i / ROAD_STEPS;
        const point = grounded(Number(loc.locX) + (Number(from.locX) - Number(loc.locX)) * t,
            Number(loc.locY) + (Number(from.locY) - Number(loc.locY)) * t,
            Number(loc.locZ) + (Number(from.locZ) - Number(loc.locZ)) * t);
        if (point) {
            Metrics.recordWalkerRoadStepBack();
            return point;
        }
    }
    return null;
}

function resolve(state, options = {}) {
    const fixed = options.keepStoreLocation === true;
    const summoned = options.forceNearPlayer === true && !fixed;
    const savedSpot = state?.spotId ? SpotService.findById(state.spotId)
        || (/^raid:\d+$/.test(state.spotId)
            ? invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(state.spotId) : null) : null;
    const source = fixed ? (options.storeLoc || state?.loc)
        : options.forceNearPlayer ? options.playerLoc
            : state?.loc || savedSpot?.center;
    const road = !fixed && !summoned && !!options.roadFrom;
    let anchor = road ? roadAnchor(source, options.roadFrom) : surface(source);
    const raid = !fixed && !summoned && savedSpot?.raidBoss === true;
    // A height-valid arrival can still be against a cliff or separated from
    // the boss by a wall. Recover before sampling around that unusable anchor,
    // rather than repeating the same isolated placement on every activation.
    if (raid) {
        const bossFloor = raidSurface(savedSpot.center);
        if (!bossFloor) return null;
        const reachable = point => point && SpotService.containsLocation(savedSpot, point) && connected(bossFloor, point);
        anchor = anchor && clearSurface(anchor);
        if (!reachable(anchor)) {
            anchor = null;
            for (const point of savedSpot.arrivalPoints || []) {
                const grounded = raidSurface(point);
                const rally = grounded && clearSurface(grounded);
                if (reachable(rally)) {
                    anchor = rally;
                    break;
                }
            }
        }
    }
    if (!anchor) return null;
    const player = options.playerLoc;
    if (player && !finiteLocation(player)) return null;
    const acceptable = (point) => {
        if (player) {
            const dist = distance(point, player);
            if (dist < (summoned ? 0 : Config.activationMinPlayerDistance) || dist > Config.activationRadius) return null;
        }
        const loc = clearSurface(point);
        if (!loc || (raid && !SpotService.containsLocation(savedSpot, loc)) || !connected(anchor, loc)) return null;
        return { loc, spot: SpotService.findCurrentSpot(loc) || null };
    };
    if (fixed) {
        const loc = clearSurface(anchor);
        return loc ? { loc, spot: SpotService.findCurrentSpot(loc) || null } : null;
    }
    if (summoned) {
        for (const radius of [48, 80, 128, 192, 256]) {
            for (let i = 0; i < 8; i++) {
                const angle = i * Math.PI / 4;
                const locX = Math.round(anchor.locX + Math.cos(angle) * radius);
                const locY = Math.round(anchor.locY + Math.sin(angle) * radius);
                const placement = acceptable({ locX, locY, locZ: Geo.getHeight(locX, locY, anchor.locZ) });
                if (placement) return placement;
            }
        }
    }
    if (options.preferAnchor === true) {
        const placement = acceptable(anchor);
        if (placement) return placement;
    }
    const placementRadius = Math.max(0, Number(options.placementRadius
        ?? (road ? ROAD_RADIUS : Config.activationPlacementRadius)) || 0);
    for (let i = 0; i < Config.activationPlacementAttempts; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * placementRadius;
        const locX = Math.round(anchor.locX + Math.cos(angle) * radius);
        const locY = Math.round(anchor.locY + Math.sin(angle) * radius);
        const placement = acceptable({ locX, locY, locZ: Geo.getHeight(locX, locY, anchor.locZ) });
        if (placement) return placement;
    }
    // Never replace an exhausted search with an unchecked displacement.
    return acceptable(anchor);
}

module.exports = { resolve };
