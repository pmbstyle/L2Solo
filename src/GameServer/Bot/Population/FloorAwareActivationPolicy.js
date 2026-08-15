const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');

const visibilityCache = new Map();

function finiteLocation(loc) {
    return !!loc && ['locX', 'locY', 'locZ'].every((key) => Number.isFinite(Number(loc[key])));
}

function locationForState(state) {
    return state?.stats?.marketStore?.loc
        || state?.stats?.craftShop?.loc
        || state?.loc
        || null;
}

function distance2d(first, second) {
    const dx = Number(first.locX) - Number(second.locX);
    const dy = Number(first.locY) - Number(second.locY);
    return Math.sqrt((dx * dx) + (dy * dy));
}

function quantizedKey(first, second) {
    const point = (loc) => [
        Number(loc.locX) >> 4,
        Number(loc.locY) >> 4,
        Math.round(Number(loc.locZ) / 64)
    ].join(':');
    return `${point(first)}>${point(second)}`;
}

function gameplayException(context = {}) {
    if (context.explicit === true || context.companion === true || context.combat === true) return true;
    return context.reason && context.reason !== 'near_player';
}

function pruneCache(timestamp, limit) {
    for (const [key, entry] of visibilityCache) {
        if (entry.expiresAt > timestamp && visibilityCache.size <= limit) break;
        visibilityCache.delete(key);
    }
}

function evaluateCandidate(state, context = {}, scan = {}) {
    if (gameplayException(context)) return { accepted: true, reason: 'gameplay_exception' };

    const playerLoc = context.playerLoc;
    const candidateLoc = context.candidateLoc || locationForState(state);
    if (!finiteLocation(playerLoc) || !finiteLocation(candidateLoc)) {
        // Historical fixtures and uncovered persisted states are permissive.
        // The result is explicit and deterministic rather than depending on a
        // failed geodata lookup or an arbitrary Z default.
        return { accepted: true, reason: 'missing_location' };
    }

    const deltaZ = Math.abs(Number(candidateLoc.locZ) - Number(playerLoc.locZ));
    const directZ = Math.max(0, Number(context.directZ ?? Config.activationFloorDirectZ) || 1200);
    if (deltaZ <= directZ) {
        return { accepted: true, reason: 'near_height', deltaZ, distance: distance2d(candidateLoc, playerLoc) };
    }

    const geodata = context.geodata || GeodataEngine;
    const hasCandidateGeo = geodata.hasGeo?.(candidateLoc.locX, candidateLoc.locY) === true;
    const hasPlayerGeo = geodata.hasGeo?.(playerLoc.locX, playerLoc.locY) === true;
    if (!hasCandidateGeo || !hasPlayerGeo) {
        return {
            accepted: true,
            reason: 'missing_geodata',
            deltaZ,
            distance: distance2d(candidateLoc, playerLoc)
        };
    }

    const timestamp = Number(context.now) || Date.now();
    const cacheMs = Math.max(0, Number(context.cacheMs ?? Config.activationFloorCacheMs) || 0);
    const cacheLimit = Math.max(1, Number(context.cacheLimit ?? Config.activationFloorCacheLimit) || 2048);
    const cache = context.cache || visibilityCache;
    const key = quantizedKey(playerLoc, candidateLoc);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > timestamp) {
        scan.cacheHits = Number(scan.cacheHits || 0) + 1;
        return { ...cached.result, cached: true };
    }

    const checkLimit = Math.max(0, Number(context.geoCheckLimit ?? Config.activationFloorGeoChecksPerScan) || 0);
    if (Number(scan.geoChecks || 0) >= checkLimit) {
        scan.budgetDeferred = Number(scan.budgetDeferred || 0) + 1;
        return {
            accepted: false,
            reason: 'geodata_budget',
            deltaZ,
            distance: distance2d(candidateLoc, playerLoc)
        };
    }

    scan.geoChecks = Number(scan.geoChecks || 0) + 1;
    const visible = geodata.hasLineOfSight(
        playerLoc.locX, playerLoc.locY, playerLoc.locZ,
        candidateLoc.locX, candidateLoc.locY, candidateLoc.locZ
    ) === true;
    const result = {
        accepted: visible,
        reason: visible ? 'visible_slope' : 'blocked_or_floor',
        deltaZ,
        distance: distance2d(candidateLoc, playerLoc)
    };
    cache.set(key, { expiresAt: timestamp + cacheMs, result });
    if (cache === visibilityCache) pruneCache(timestamp, cacheLimit);
    else if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    return result;
}

function filterCandidates(states = [], context = {}) {
    const startedAt = Date.now();
    const scan = { geoChecks: 0, cacheHits: 0, budgetDeferred: 0 };
    const accepted = [];
    const decisions = (states || []).map((state) => {
        const result = evaluateCandidate(state, context, scan);
        if (result.accepted) accepted.push(state);
        return { state, ...result };
    });
    Metrics.recordActivationFloorScan({
        candidates: decisions.length,
        accepted: accepted.length,
        rejected: decisions.length - accepted.length,
        geoChecks: scan.geoChecks,
        cacheHits: scan.cacheHits,
        budgetDeferred: scan.budgetDeferred,
        durationMs: Date.now() - startedAt,
        reasons: decisions.reduce((counts, decision) => {
            counts[decision.reason] = Number(counts[decision.reason] || 0) + 1;
            return counts;
        }, {})
    });
    return { accepted, decisions, scan };
}

module.exports = {
    evaluateCandidate,
    filterCandidates,
    resetCache() {
        visibilityCache.clear();
    }
};
