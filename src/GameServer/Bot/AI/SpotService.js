const GRID_SIZE = 6000;
const DEFAULT_LEVEL_RANGE = 3;
const DEFAULT_MIN_HUNT_LEVEL_GAP = -7;
const DEFAULT_MAX_HUNT_LEVEL_GAP = 3;
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const WorldAreaCatalog = invoke('GameServer/World/WorldAreaCatalog');

const anonymousStateIds = new WeakMap();
let nextAnonymousStateId = 1;

function distance2d(a, b) {
    if (!a || !b) return 0;
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt(dx * dx + dy * dy);
}

function locFromActor(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function spotName(spot) {
    const primary = spot.npcNames[0] || 'Hunting Ground';
    if (spot.npcNames.length <= 1) return primary;
    return `${primary} fields`;
}

function levelCount(spot, level) {
    return Number(spot?.levelCounts?.[String(level)] || spot?.levelCounts?.[level] || 0);
}

function finiteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function stableHash(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function identitySeedForState(state) {
    for (const value of [state?.characterId, state?.name, state?.stats?.generatedIndex]) {
        if (value !== null && value !== undefined && value !== '') return String(value);
    }
    if (!state || typeof state !== 'object') return 'anonymous:primitive';
    if (!anonymousStateIds.has(state)) anonymousStateIds.set(state, nextAnonymousStateId++);
    return `anonymous:${anonymousStateIds.get(state)}`;
}

function constrainToSpotGrid(spot, locX, locY) {
    const match = /^(-?\d+)_(-?\d+)$/.exec(String(spot?.id || ''));
    if (!match) return { locX, locY };
    const gridX = Number(match[1]);
    const gridY = Number(match[2]);
    return {
        locX: Math.max(gridX * GRID_SIZE, Math.min((gridX + 1) * GRID_SIZE - 1, locX)),
        locY: Math.max(gridY * GRID_SIZE, Math.min((gridY + 1) * GRID_SIZE - 1, locY))
    };
}

function huntBand(targetLevel, options = {}) {
    const level = Math.max(1, finiteNumber(targetLevel, 1));
    return {
        min: Math.max(1, level + finiteNumber(options.minLevelGap, DEFAULT_MIN_HUNT_LEVEL_GAP)),
        max: Math.max(1, level + finiteNumber(options.maxLevelGap, DEFAULT_MAX_HUNT_LEVEL_GAP))
    };
}

function eligibleDensity(spot, targetLevel, options = {}) {
    if (!spot) return 0;
    const band = huntBand(targetLevel, options);
    if (spot.levelCounts && Object.keys(spot.levelCounts).length > 0) {
        let count = 0;
        for (let level = band.min; level <= band.max; level++) count += levelCount(spot, level);
        return count;
    }
    // Fixtures and older persisted profiles may only carry min/max metadata.
    // Keep them usable, but do not pretend a mixed sector is fully eligible.
    const min = Number(spot.minLevel || 1);
    const max = Number(spot.maxLevel || min);
    if (max < band.min || min > band.max) return 0;
    return Math.min(Number(spot.density || 0), Math.max(1, Number(spot.density || 0) * 0.5));
}

function levelFit(spot, targetLevel, options = {}) {
    const band = huntBand(targetLevel, options);
    const eligible = eligibleDensity(spot, targetLevel, options);
    const density = Math.max(1, Number(spot?.density || 1));
    const ratio = eligible / density;
    const avgLevel = Number(spot?.avgLevel || spot?.minLevel || 1);
    const target = Math.max(1, Number(targetLevel || 1));
    const dangerous = Math.max(0, Number(spot?.maxLevel || avgLevel) - (target + Number(options.maxLevelGap ?? DEFAULT_MAX_HUNT_LEVEL_GAP)));
    return {
        band,
        eligibleDensity: eligible,
        eligibleRatio: ratio,
        averageGap: Math.abs(avgLevel - target),
        dangerousLevelSpan: dangerous
    };
}

function isSuitable(spot, targetLevel, options = {}) {
    if (!spot) return false;
    const fit = levelFit(spot, targetLevel, options);
    const minDensity = Math.max(1, Number(options.minEligibleDensity ?? 3));
    const minRatio = Math.max(0, Math.min(1, Number(options.minEligibleRatio ?? 0.25)));
    return fit.eligibleDensity >= minDensity && fit.eligibleRatio >= minRatio;
}

const SpotService = {
    spots: null,

    reset() {
        this.spots = null;
    },

    ensureIndexed() {
        if (this.spots) return this.spots;

        const World = invoke('GameServer/World/World');
        if (!World?.npc?.spawns || !Array.isArray(World.npc.spawns)) return [];
        const sectors = {};

        World.npc.spawns.forEach((npc) => {
            if (!npc.fetchAttackable || !npc.fetchAttackable()) return;

            const gx = Math.floor(npc.fetchLocX() / GRID_SIZE);
            const gy = Math.floor(npc.fetchLocY() / GRID_SIZE);
            const key = `${gx}_${gy}`;

            if (!sectors[key]) {
                sectors[key] = {
                    id: key,
                    count: 0,
                    sumX: 0,
                    sumY: 0,
                    sumZ: 0,
                    minLevel: Infinity,
                    maxLevel: 0,
                    levels: {},
                    names: {},
                    selfIds: {},
                    npcs: {},
                    arrivalPoints: []
                };
            }

            const sector = sectors[key];
            const level = npc.fetchLevel();
            const name = npc.fetchName();

            sector.count++;
            sector.sumX += npc.fetchLocX();
            sector.sumY += npc.fetchLocY();
            sector.sumZ += npc.fetchLocZ();
            sector.minLevel = Math.min(sector.minLevel, level);
            sector.maxLevel = Math.max(sector.maxLevel, level);
            sector.levels[level] = (sector.levels[level] || 0) + 1;
            sector.names[name] = (sector.names[name] || 0) + 1;
            const selfId = Number(npc.fetchSelfId?.() || 0);
            if (selfId) sector.selfIds[selfId] = (sector.selfIds[selfId] || 0) + 1;
            const npcKey = selfId ? `id:${selfId}` : `name:${name}`;
            sector.npcs[npcKey] = sector.npcs[npcKey] || { selfId, name, level, count: 0 };
            sector.npcs[npcKey].count++;
            sector.arrivalPoints.push({
                locX: npc.fetchLocX(),
                locY: npc.fetchLocY(),
                locZ: npc.fetchLocZ()
            });
        });

        this.spots = Object.values(sectors).map((sector) => {
            const levelEntries = Object.entries(sector.levels)
                .map(([level, count]) => ({ level: Number(level), count }))
                .sort((a, b) => b.count - a.count);
            const nameEntries = Object.entries(sector.names)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count);
            const selfIdEntries = Object.entries(sector.selfIds)
                .map(([selfId, count]) => ({ selfId: Number(selfId), count }))
                .sort((a, b) => b.count - a.count);
            const avgLevel = levelEntries.reduce((sum, item) => sum + item.level * item.count, 0) / sector.count;

            const spot = {
                id: sector.id,
                name: '',
                center: {
                    locX: Math.round(sector.sumX / sector.count),
                    locY: Math.round(sector.sumY / sector.count),
                    locZ: Math.round(sector.sumZ / sector.count)
                },
                minLevel: sector.minLevel,
                maxLevel: sector.maxLevel,
                avgLevel: Math.round(avgLevel * 10) / 10,
                density: sector.count,
                npcNames: nameEntries.slice(0, 3).map((item) => item.name),
                npcSelfIds: selfIdEntries.slice(0, 8).map((item) => item.selfId),
                npcEntries: Object.values(sector.npcs)
                    .sort((a, b) => b.count - a.count)
                    .map((entry) => ({ ...entry })),
                arrivalPoints: sector.arrivalPoints.map((point) => ({ ...point })),
                levelCounts: { ...sector.levels },
                dominantLevels: levelEntries.slice(0, 3)
            };

            spot.name = spotName(spot);
            return WorldAreaCatalog.decorateSpot(spot);
        });

        return this.spots;
    },

    findById(id) {
        return this.ensureIndexed().find((spot) => spot.id === id) || null;
    },

    findCurrentSpot(loc) {
        if (!loc || !Number.isFinite(Number(loc.locX)) || !Number.isFinite(Number(loc.locY))) return null;
        const gx = Math.floor(loc.locX / GRID_SIZE);
        const gy = Math.floor(loc.locY / GRID_SIZE);
        return this.findById(`${gx}_${gy}`);
    },

    findBestSpot(status, options = {}) {
        const loc = status.loc;
        const targetLevel = options.level || status.level || 1;
        const levelRange = options.levelRange || DEFAULT_LEVEL_RANGE;
        const currentSpotId = status.spot?.id;
        const minDistance = options.minDistance || 1200;
        const maxDistance = options.maxDistance || 90000;

        const candidates = this.ensureIndexed()
            .filter((spot) => spot.density >= (options.minDensity || 4))
            .filter((spot) => spot.minLevel <= targetLevel + levelRange && spot.maxLevel >= targetLevel - levelRange)
            .filter((spot) => isSuitable(spot, targetLevel, options))
            .filter((spot) => {
                const dist = distance2d(loc, spot.center);
                return dist >= minDistance && dist <= maxDistance;
            })
            .map((spot) => {
                const fit = levelFit(spot, targetLevel, options);
                const levelGap = fit.averageGap;
                const dist = distance2d(loc, spot.center);
                const sameSpotPenalty = currentSpotId && currentSpotId === spot.id ? 100 : 0;
                const peacePenalty = utils.isInPeaceZone(spot.center.locX, spot.center.locY) ? 40 : 0;

                return {
                    spot,
                    score: (fit.eligibleDensity * 5) + (fit.eligibleRatio * 30)
                        - (levelGap * 18)
                        - (fit.dangerousLevelSpan * 3)
                        - (dist / 2500)
                        - sameSpotPenalty
                        - peacePenalty,
                    distance: dist,
                    levelGap,
                    eligibleDensity: fit.eligibleDensity,
                    eligibleRatio: fit.eligibleRatio
                };
            })
            .map((candidate) => {
                const routeMatch = LevelingRoutes.scoreSpot(candidate.spot, {
                    characterId: status.characterId,
                    name: status.name,
                    level: targetLevel,
                    stats: {
                        ...(status.stats || {}),
                        role: status.role,
                        classId: status.classId,
                        starterRegion: status.starterRegion || status.stats?.starterRegion
                    }
                }, {
                    mode: options.mode || 'solo',
                    role: options.role || status.role,
                    occupancy: options.occupancy
                });
                const decoratedSpot = LevelingRoutes.decorateSpot(candidate.spot, routeMatch);
                return {
                    ...candidate,
                    spot: decoratedSpot,
                    score: candidate.score + routeMatch.routeScore + routeMatch.variation
                        - routeMatch.crowdPenalty - routeMatch.localityPenalty,
                    route: decoratedSpot.route || null,
                    routeScore: routeMatch.routeScore,
                    crowdPenalty: routeMatch.crowdPenalty,
                    localityPenalty: routeMatch.localityPenalty,
                    variation: routeMatch.variation
                };
            })
            .sort((a, b) => b.score - a.score);

        return candidates[0] || null;
    },

    assignSpot(session, spot) {
        if (!spot) return null;
        session.currentSpot = {
            id: spot.id,
            name: spot.name,
            center: { ...spot.center },
            minLevel: spot.minLevel,
            maxLevel: spot.maxLevel,
            avgLevel: spot.avgLevel,
            density: spot.density,
            npcNames: [...spot.npcNames],
            route: spot.route || null
        };
        return session.currentSpot;
    },

    randomPointNear(spot, radius = 900) {
        const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * radius;
        const locX = Math.round(spot.center.locX + Math.cos(angle) * dist);
        const locY = Math.round(spot.center.locY + Math.sin(angle) * dist);

        return {
            locX,
            locY,
            locZ: GeodataEngine.getHeight(locX, locY, spot.center.locZ)
        };
    },

    arrivalPointForState(state, spot) {
        if (!spot?.center) return null;
        const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
        const points = spot.arrivalPoints?.length ? spot.arrivalPoints : [spot.center];
        const seed = identitySeedForState(state);
        const anchorHash = stableHash(`${seed}:anchor`);
        const angleHash = stableHash(`${seed}:angle`);
        const radiusHash = stableHash(`${seed}:radius`);
        const anchor = points[anchorHash % points.length] || spot.center;
        const angle = ((angleHash % 360) * Math.PI) / 180;
        const radius = 96 + (radiusHash % 161);
        const point = constrainToSpotGrid(
            spot,
            Math.round(Number(anchor.locX || 0) + Math.cos(angle) * radius),
            Math.round(Number(anchor.locY || 0) + Math.sin(angle) * radius)
        );
        return {
            locX: point.locX,
            locY: point.locY,
            locZ: GeodataEngine.getHeight(point.locX, point.locY, Number(anchor.locZ || spot.center.locZ || 0))
        };
    },

    describe(spot) {
        if (!spot) return 'unknown spot';
        return `${spot.name} (Lv ${spot.minLevel}-${spot.maxLevel}, density ${spot.density})`;
    },

    distance2d,
    eligibleDensity,
    huntBand,
    isSuitable,
    levelFit,
    locFromActor
};

module.exports = SpotService;
