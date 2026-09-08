const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Geo = invoke('GameServer/Geodata/GeodataEngine');

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

function resolve(state, options = {}) {
    const fixed = options.keepStoreLocation === true;
    const savedSpot = state?.spotId ? SpotService.findById(state.spotId) : null;
    const source = fixed ? (options.storeLoc || state?.loc)
        : options.forceNearPlayer ? options.playerLoc
            : state?.loc || savedSpot?.center;
    const anchor = surface(source);
    if (!anchor) return null;
    const player = options.playerLoc;
    if (player && !finiteLocation(player)) return null;
    const acceptable = (point) => {
        if (player) {
            const dist = distance(point, player);
            if (dist < Config.activationMinPlayerDistance || dist > Config.activationRadius) return null;
        }
        const loc = clearSurface(point);
        if (!loc || !connected(anchor, loc)) return null;
        return { loc, spot: SpotService.findCurrentSpot(loc) || null };
    };
    if (fixed) {
        const loc = clearSurface(anchor);
        return loc ? { loc, spot: SpotService.findCurrentSpot(loc) || null } : null;
    }
    for (let i = 0; i < Config.activationPlacementAttempts; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * Config.activationPlacementRadius;
        const locX = Math.round(anchor.locX + Math.cos(angle) * radius);
        const locY = Math.round(anchor.locY + Math.sin(angle) * radius);
        const placement = acceptable({ locX, locY, locZ: Geo.getHeight(locX, locY, anchor.locZ) });
        if (placement) return placement;
    }
    // Never replace an exhausted search with an unchecked displacement.
    return acceptable(anchor);
}

module.exports = { resolve };
