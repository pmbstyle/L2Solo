const GRID_SIZE = 6000;
const DEFAULT_LEVEL_RANGE = 3;
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');

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

const SpotService = {
    spots: null,

    reset() {
        this.spots = null;
    },

    ensureIndexed() {
        if (this.spots) return this.spots;

        const World = invoke('GameServer/World/World');
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
                    selfIds: {}
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
                dominantLevels: levelEntries.slice(0, 3)
            };

            spot.name = spotName(spot);
            return spot;
        });

        return this.spots;
    },

    findById(id) {
        return this.ensureIndexed().find((spot) => spot.id === id) || null;
    },

    findCurrentSpot(loc) {
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
            .filter((spot) => {
                const dist = distance2d(loc, spot.center);
                return dist >= minDistance && dist <= maxDistance;
            })
            .map((spot) => {
                const levelGap = Math.abs(spot.avgLevel - targetLevel);
                const dist = distance2d(loc, spot.center);
                const sameSpotPenalty = currentSpotId && currentSpotId === spot.id ? 100 : 0;
                const peacePenalty = utils.isInPeaceZone(spot.center.locX, spot.center.locY) ? 40 : 0;

                return {
                    spot,
                    score: (spot.density * 3) - (levelGap * 18) - (dist / 2500) - sameSpotPenalty - peacePenalty,
                    distance: dist,
                    levelGap
                };
            })
            .map((candidate) => {
                const routeMatch = LevelingRoutes.scoreSpot(candidate.spot, {
                    level: targetLevel,
                    stats: {
                        role: status.role,
                        classId: status.classId
                    }
                }, {
                    mode: options.mode || 'solo',
                    role: options.role || status.role
                });
                const decoratedSpot = LevelingRoutes.decorateSpot(candidate.spot, routeMatch);
                return {
                    ...candidate,
                    spot: decoratedSpot,
                    score: candidate.score + routeMatch.routeScore,
                    route: decoratedSpot.route || null,
                    routeScore: routeMatch.routeScore
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

    describe(spot) {
        if (!spot) return 'unknown spot';
        return `${spot.name} (Lv ${spot.minLevel}-${spot.maxLevel}, density ${spot.density})`;
    },

    distance2d,
    locFromActor
};

module.exports = SpotService;
