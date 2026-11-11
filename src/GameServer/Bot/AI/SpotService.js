const { SPOT_CELL_SIZE, CLIENT_VISIBILITY_RADIUS } = invoke('GameServer/World/WorldConstants');
const DEFAULT_MIN_HUNT_LEVEL_GAP = -7;
const DEFAULT_MAX_HUNT_LEVEL_GAP = 3;
// The farthest hunting spot a hot bot reaches on foot; beyond it, SoE or a gatekeeper.
const MAX_WALK_SPOT_DISTANCE = 12000;
// A walk to a spot ends this close to its point (HuntingState's relocation), and a
// body this close to a spot's center, or on its ground, has arrived there (arrivedAt).
const SPOT_ARRIVAL_RADIUS = 1000;
// The fewest spawns of a bot's band a spot is suitable with (isSuitable). A
// cell piece with fewer spawns is an edge fragment: it joins the
// field of its species in a neighbour cell.
const MIN_ELIGIBLE_DENSITY = 3;
// Spot ids: the cell `x_y`, `:area` inside a partitioned dungeon, `:f<n>` for
// a floor of a cell split by height.
const GRID_SPOT_ID = /^(-?\d+)_(-?\d+)(?::.+)?$/;
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const WorldAreaCatalog = invoke('GameServer/World/WorldAreaCatalog');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const BotHuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const BotPullEstimate = invoke('GameServer/Bot/AI/BotPullEstimate');
const GameTime = invoke('GameServer/World/GameTime');

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

// A spot's level mix: the band its spawns' levels fill, their mean
// plus and minus their standard deviation, from its level counts; a spot
// with only min/max metadata (fixtures, older profiles): min..max. One answer
// per counts object (spawn data, never written after the catalogue builds it).
const levelMixes = new WeakMap();
function levelMix(spot) {
    const counts = spot?.levelCounts;
    if (counts && typeof counts === 'object') {
        let mix = levelMixes.get(counts);
        if (mix === undefined) {
            let n = 0, sum = 0, squares = 0;
            for (const level in counts) {
                const count = Number(counts[level]) || 0;
                n += count; sum += Number(level) * count; squares += Number(level) * Number(level) * count;
            }
            const mean = n > 0 ? sum / n : 0;
            mix = n > 0 ? { low: mean - Math.sqrt(Math.max(0, squares / n - mean * mean)),
                high: mean + Math.sqrt(Math.max(0, squares / n - mean * mean)) } : null;
            levelMixes.set(counts, mix);
        }
        if (mix) return mix;
    }
    const min = Number(spot?.minLevel || 1);
    return { low: min, high: Number(spot?.maxLevel || min) };
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

// The area the spawns of a spot cover: a uniform spread over a w x h
// rectangle has sigma w / sqrt(12), so 12 sigmaX sigmaY; at least the area
// their own spacing gives under the walk rule that reads it: the
// solo walk (BackgroundResolver.soloWalkMs) takes the mean distance to the
// nearest of n spawns over an area A as 1 / (2 sqrt(n / A)), so the spawns'
// measured mean nearest distance d gives A = 4 n d^2. Two or three spawns on
// a line have no spread across it, yet the walk between them is their
// distance. At most the cells the spot covers (SPOT_CELL_SIZE squared each),
// null without spawns.
function spawnArea(records = [], cells = 1) {
    if (!records.length) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0;
    for (const record of records) { sx += record.x; sy += record.y; sxx += record.x * record.x; syy += record.y * record.y; }
    const n = records.length, vx = Math.max(0, sxx / n - (sx / n) ** 2), vy = Math.max(0, syy / n - (sy / n) ** 2);
    let nearest = 0;
    for (let at = 0; n > 1 && at < n; at++) {
        let best = Infinity;
        for (let other = 0; other < n; other++) {
            if (other === at) continue;
            const dx = records[other].x - records[at].x, dy = records[other].y - records[at].y;
            best = Math.min(best, dx * dx + dy * dy);
        }
        nearest += Math.sqrt(best) / n;
    }
    return Math.round(Math.min(cells * SPOT_CELL_SIZE * SPOT_CELL_SIZE,
        Math.max(12 * Math.sqrt(vx * vy), 4 * n * nearest * nearest)));
}

// A point drawn around a spawn of a grid spot stays in that spawn's cell (a
// spot of several cells keeps each anchor's own).
function constrainToSpotGrid(spot, anchor, locX, locY) {
    if (!GRID_SPOT_ID.test(String(spot?.id || ''))) return { locX, locY };
    const gridX = Math.floor(Number(anchor.locX) / SPOT_CELL_SIZE);
    const gridY = Math.floor(Number(anchor.locY) / SPOT_CELL_SIZE);
    return {
        locX: Math.max(gridX * SPOT_CELL_SIZE, Math.min((gridX + 1) * SPOT_CELL_SIZE - 1, locX)),
        locY: Math.max(gridY * SPOT_CELL_SIZE, Math.min((gridY + 1) * SPOT_CELL_SIZE - 1, locY))
    };
}

function partitionedAreaAt(loc) {
    const area = WorldAreaCatalog.resolve(loc);
    if (!area?.tags?.some((tag) => tag === 'catacomb' || tag === 'party_required')) return null;
    return area;
}

// The grid cell of a point: its key `x_y` (plus `:area` inside a partitioned
// dungeon) and that area.
function cellAt(loc) {
    const gx = Math.floor(Number(loc.locX) / SPOT_CELL_SIZE);
    const gy = Math.floor(Number(loc.locY) / SPOT_CELL_SIZE);
    const area = partitionedAreaAt(loc);
    return { key: `${gx}_${gy}${area ? `:${area.id}` : ''}`, gx, gy, area };
}

// Spot cutting: a cell's spawns on floors
// apart by more than `bound` in height are separate spots. The floors of the
// spawns sorted by height, each spawn on its floor in its own order.
function floorsOf(items, bound) {
    const heights = items.map((item) => item.z).sort((a, b) => a - b);
    const tops = [];
    for (let at = 1; at < heights.length; at++) if (heights[at] - heights[at - 1] > bound) tops.push(heights[at - 1]);
    const floors = Array.from({ length: tops.length + 1 }, () => []);
    for (const item of items) {
        let floor = 0;
        while (floor < tops.length && item.z > tops[floor]) floor++;
        floors[floor].push(item);
    }
    return floors;
}

// The cell pieces of the catalogue: one per floor of each cell. The floor
// with the most spawns keeps the cell key as its id (the spot id bots saved
// before cells were split by height), the others are `<cell>:f<n>`, n the
// floor counted from the bottom. A
// split piece's band reaches halfway to the next floor (SpotIndex.spotAt).
function cellPieces(cells, bound) {
    const pieces = [];
    for (const cell of cells.values()) {
        const floors = floorsOf(cell.items, bound);
        let main = 0;
        for (let at = 1; at < floors.length; at++) if (floors[at].length > floors[main].length) main = at;
        const lowest = floors.map((floor) => Math.min(...floor.map((item) => item.z)));
        const highest = floors.map((floor) => Math.max(...floor.map((item) => item.z)));
        floors.forEach((items, at) => pieces.push({
            ...cell, items,
            id: at === main ? cell.key : `${cell.key}:f${at + 1}`,
            floor: floors.length < 2 ? null : {
                cell: cell.key,
                low: at > 0 ? (highest[at - 1] + lowest[at]) / 2 : null,
                high: at < floors.length - 1 ? (highest[at] + lowest[at + 1]) / 2 : null
            }
        }));
    }
    return pieces;
}

// an edge fragment (a piece with fewer spawns than MIN_ELIGIBLE_DENSITY)
// joins the piece of a neighbour cell (the same area partition) holding the
// most of its spawns' species within `reach` and on its floor (`bound` in
// height), ties to the nearest; a fragment of no such field stays alone. A
// fragment that joins a fragment ends in that one's field; fragments joined
// only among themselves take the largest one's id. Returns piece -> the piece
// whose spot it is part of.
function joinedPieces(pieces, bound, reach) {
    const byCell = new Map();
    for (const piece of pieces) {
        if (!byCell.has(piece.key)) byCell.set(piece.key, []);
        byCell.get(piece.key).push(piece);
    }
    const target = new Map();
    for (const piece of pieces) {
        if (piece.items.length >= MIN_ELIGIBLE_DENSITY) continue;
        let best = null;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                for (const other of byCell.get(`${piece.gx + dx}_${piece.gy + dy}${piece.suffix}`) || []) {
                    let links = 0, nearest = Infinity;
                    for (const item of piece.items) {
                        let distance = Infinity;
                        for (const spawn of other.items) {
                            if (spawn.npcKey !== item.npcKey || Math.abs(spawn.z - item.z) > bound) continue;
                            distance = Math.min(distance, Math.hypot(spawn.x - item.x, spawn.y - item.y));
                        }
                        if (distance <= reach) { links++; nearest = Math.min(nearest, distance); }
                    }
                    if (links && (!best || links > best.links || (links === best.links && nearest < best.nearest))) {
                        best = { other, links, nearest };
                    }
                }
            }
        }
        if (best) target.set(piece, best.other);
    }
    const larger = (a, b) => (b.items.length > a.items.length
        || (b.items.length === a.items.length && b.id < a.id) ? b : a);
    const roots = new Map();
    for (const piece of pieces) {
        const path = [];
        let at = piece;
        while (target.has(at) && !path.includes(at)) { path.push(at); at = target.get(at); }
        let root = at;
        // A loop of fragments: its largest piece.
        if (target.has(at)) for (let step = target.get(at); step !== at; step = target.get(step)) root = larger(root, step);
        roots.set(piece, root);
    }
    return roots;
}

// The spot of the pieces of one field: its spawns' counts, levels, names,
// production and pull records; its id, floor band and the pieces it took in
// (SpotIndex.piecesOf) from its root piece.
function spotOfPieces(root, members) {
    const sector = { count: 0, sumX: 0, sumY: 0, sumZ: 0, minLevel: Infinity, maxLevel: 0,
        levels: {}, names: {}, selfIds: {}, npcs: {}, arrivalPoints: [], records: [] };
    for (const member of members) {
        for (const item of member.items) {
            sector.count++;
            sector.sumX += item.x;
            sector.sumY += item.y;
            sector.sumZ += item.z;
            sector.minLevel = Math.min(sector.minLevel, item.level);
            sector.maxLevel = Math.max(sector.maxLevel, item.level);
            sector.levels[item.level] = (sector.levels[item.level] || 0) + 1;
            sector.names[item.name] = (sector.names[item.name] || 0) + 1;
            if (item.selfId) sector.selfIds[item.selfId] = (sector.selfIds[item.selfId] || 0) + 1;
            sector.npcs[item.npcKey] = sector.npcs[item.npcKey]
                || { selfId: item.selfId, name: item.name, level: item.level, count: 0, production: 0 };
            sector.npcs[item.npcKey].count++;
            sector.npcs[item.npcKey].production += item.production;
            sector.arrivalPoints.push({ locX: item.x, locY: item.y, locZ: item.z });
            sector.records.push(item.record);
        }
    }
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
    const joins = members.filter((member) => member !== root)
        .map((member) => ({ id: member.id, cell: member.key, low: member.floor?.low ?? null, high: member.floor?.high ?? null }));
    const spot = {
        id: root.id,
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
        // `production`: the group's mobs per hour from its respawns.
        npcEntries: Object.values(sector.npcs)
            .sort((a, b) => b.count - a.count)
            .map((entry) => ({ ...entry, production: Math.round(entry.production * 100) / 100 })),
        arrivalPoints: sector.arrivalPoints,
        levelCounts: { ...sector.levels },
        dominantLevels: levelEntries.slice(0, 3),
        partitionedAreaId: root.area?.id || null,
        // the floor band of a cell split by height, the pieces taken in.
        floor: root.floor,
        joins: joins.length ? joins : null,
        // The square its spawns cover (the solo walk): a uniform
        // spread's 12 sigmaX sigmaY, at most the cells of the spot.
        spawnArea: spawnArea(sector.records, new Set(members.map((member) => member.key)).size),
        records: sector.records
    };
    spot.name = spotName(spot);
    return spot;
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

// Mobs per hour one spawn gives back: 3600 / its respawn seconds. The
// respawn spread is symmetric (SpawnNpcs.respawnDelayMs), so its mean is
// `respawn`; a leader's minions come back with their leader. A day or night
// spawn gives back only in its period: over the game day, its share of the
// day (GameTime.periodShare).
function respawnsPerHour(npc) {
    const spawn = (npc?.spawnDefinition || npc?.minionLeader?.spawnDefinition)?.spawn;
    const respawn = Number(spawn?.respawn) || 0;
    return respawn > 0 ? 3600 / respawn * GameTime.periodShare(spawn.period) : 0;
}

function isSuitable(spot, targetLevel, options = {}) {
    if (!spot) return false;
    const fit = levelFit(spot, targetLevel, options);
    const minDensity = Math.max(1, Number(options.minEligibleDensity ?? MIN_ELIGIBLE_DENSITY));
    const minRatio = Math.max(0, Math.min(1, Number(options.minEligibleRatio ?? 0.25)));
    return fit.eligibleDensity >= minDensity && fit.eligibleRatio >= minRatio;
}

const SpotService = {
    MAX_WALK_SPOT_DISTANCE,
    SPOT_ARRIVAL_RADIUS,
    respawnsPerHour,
    spots: null,

    reset() {
        this.spots = null;
    },

    ensureIndexed() {
        if (this.spots) return this.spots;

        const World = invoke('GameServer/World/World');
        if (!Array.isArray(World?.npc?.definitions)) return [];
        // lazy: worker SpotService also loads in the cold worker; these aggro owners import the live world.
        const SocialAggro = invoke('GameServer/Npc/SocialAggro');
        const NpcAggro = invoke('GameServer/Npc/NpcAggro'); // lazy: worker as SocialAggro above.
        const MinionManager = invoke('GameServer/World/RaidBossMinionManager'); // lazy: worker as SocialAggro above.
        // spawns farther apart in height than a mob assists or aggroes
        // (SocialAggro, NpcAggro) share no fight: another floor.
        const floorBound = Math.max(SocialAggro.MAX_ASSIST_Z_DIFFERENCE, NpcAggro.MAX_AGGRO_Z_DIFFERENCE);
        const cells = new Map();
        // Every spawn of the game day at its seeded catalogue point
        // (SpawnNpcs.catalogueSpawns): the same spots at every start, the
        // ones the spot table measures.
        const spawns = invoke('GameServer/World/Generics/SpawnNpcs').catalogueSpawns(World); // lazy: the worker's SpotService never indexes

        const index = (npc) => {
            if (!npc.fetchAttackable || !npc.fetchAttackable()) return;
            if (BotRaidSafety.isProtectedRaidEntity(npc)) return;
            if (!BotHuntingTargetPolicy.canHunt(npc)) return;

            const loc = {
                locX: npc.fetchLocX(),
                locY: npc.fetchLocY(),
                locZ: npc.fetchLocZ()
            };
            const cell = cellAt(loc);
            if (!cells.has(cell.key)) {
                cells.set(cell.key, { key: cell.key, gx: cell.gx, gy: cell.gy, area: cell.area,
                    suffix: cell.area ? `:${cell.area.id}` : '', items: [] });
            }
            const name = npc.fetchName();
            const selfId = Number(npc.fetchSelfId?.() || 0);
            cells.get(cell.key).items.push({
                x: loc.locX, y: loc.locY, z: loc.locZ, level: npc.fetchLevel(), name, selfId,
                npcKey: selfId ? `id:${selfId}` : `name:${name}`,
                production: respawnsPerHour(npc),
                record: BotPullEstimate.record(npc)
            });
        };
        spawns.forEach(index);

        // A hunter of a field sees a spawn within the client's visibility
        // radius: an edge fragment's spawn of a species the neighbour field
        // holds that close belongs to that field.
        const pieces = cellPieces(cells, floorBound);
        const roots = joinedPieces(pieces, floorBound, CLIENT_VISIBILITY_RADIUS);
        const members = new Map();
        for (const piece of pieces) {
            const root = roots.get(piece);
            if (!members.has(root)) members.set(root, []);
            members.get(root).push(piece);
        }
        this.spots = pieces.filter((piece) => members.has(piece))
            .map((root) => WorldAreaCatalog.decorateSpot(spotOfPieces(root, members.get(root))));
        const pulls = BotPullEstimate.annotate(this.spots, {
            assistZ: SocialAggro.MAX_ASSIST_Z_DIFFERENCE,
            aggroRadius: NpcAggro.AGGRO_RADIUS,
            aggroZ: NpcAggro.MAX_AGGRO_Z_DIFFERENCE
        }, BotPullEstimate.minionJoiners(MinionManager.groupsByBoss));
        // One number on each spot entry that pulls more than one mob, in this
        // catalogue, its SpotProfiles copy and the cold worker's copy.
        utils.infoSuccess('Spots', '%d spots (%d cells, %d floors split off, %d fragments joined, %d spawns), pull table %d of %d entries above one (~%d KB per copy)',
            this.spots.length, cells.size, pieces.filter((piece) => piece.id !== piece.key).length,
            pieces.length - this.spots.length, spawns.length, pulls.pulls, pulls.entries, Math.ceil(pulls.pulls * 16 / 1024));

        return this.spots;
    },

    // The mobs of a caller's world scan that can join a pull: alive, attackable,
    // not on a target yet, no raid entity.
    idleMobs(npcs) {
        return npcs.filter(npc => !BotRaidSafety.isProtectedRaidEntity(npc) && npc.fetchAttackable?.() && !npc.isDead?.() && !npc.fetchDestId?.());
    },

    // A caller's world scan made ready for livePull, once per scan, no scan of its own.
    idlePack(npcs) {
        const SocialAggro = invoke('GameServer/Npc/SocialAggro'); // lazy: worker never reaches this hot read (ensureIndexed).
        const NpcAggro = invoke('GameServer/Npc/NpcAggro'); // lazy: as SocialAggro above.
        return BotPullEstimate.packIndex(this.idleMobs(npcs).map(BotPullEstimate.record), { assistZ: SocialAggro.MAX_ASSIST_Z_DIFFERENCE,
            aggroRadius: NpcAggro.AGGRO_RADIUS, aggroZ: NpcAggro.MAX_AGGRO_Z_DIFFERENCE });
    },

    // The mobs that come with a live npc now: the bot stands before it and its
    // pack (BotPullEstimate.packPull over an idlePack).
    livePull(npc, pack) {
        return BotPullEstimate.packPull(BotPullEstimate.record(npc), pack);
    },

    findById(id) {
        return SpotIndex.spotById(this.ensureIndexed(), id);
    },

    // The spot covering a point: its cell, and its floor by the point's
    // height (SpotIndex.spotAt). `spots`: a catalogue with the same pieces
    // (SpotProfiles), for callers without the live world such as the cold worker.
    findCurrentSpot(loc, spots = null) {
        if (!loc || !Number.isFinite(Number(loc.locX)) || !Number.isFinite(Number(loc.locY))) return null;
        return SpotIndex.spotAt(spots || this.ensureIndexed(), cellAt(loc).key, Number(loc.locZ));
    },

    // The spot a bot stands at, one rule for the hot body and the cold worker:
    // its declared spot when its position is unknown, else a declared raid
    // profile once the body has arrived there (it is virtual and sits inside an
    // ordinary sector; the party resolver needs the boss profile, not the field
    // around it), else the spot under its position, else its declared spot when
    // the body has arrived there (arrivedAt: a walk ends within the arrival
    // radius, often on a neighbouring cell with no spot). A body far from its
    // declared spot (in town after a visit or a raid) stands on none.
    // `spots`: the catalogue (the worker's), else the live index.
    standingSpot(state, spots = null) {
        const catalog = spots || this.ensureIndexed();
        const declared = SpotIndex.spotById(catalog, state?.spotId || '');
        const loc = state?.loc;
        const placed = !!loc && Number.isFinite(Number(loc.locX)) && Number.isFinite(Number(loc.locY));
        if (!placed) return declared;
        if (declared?.raidBoss === true && this.arrivedAt(declared, loc)) return declared;
        return this.findCurrentSpot(loc, catalog) || (declared && this.arrivedAt(declared, loc) ? declared : null);
    },

    // Has a body at loc arrived at spot: on its ground (floor-aware, containsLocation)
    // or within the arrival radius of its center? The one arrival rule of a walk's end
    // and of "on the planned spot" (BotDecisionService), never an exact cell match.
    // A profile with no ground of its own (not a grid spot or a raid's) is the radius alone.
    arrivedAt(spot, loc) {
        if (!spot?.center) return false;
        const ground = spot.raidBoss === true || GRID_SPOT_ID.test(String(spot.id || ''));
        return (ground && this.containsLocation(spot, loc)) || distance2d(spot.center, loc) <= SPOT_ARRIVAL_RADIUS;
    },

    containsLocation(spot, loc) {
        if (!loc || !['locX', 'locY', 'locZ'].every(key => Number.isFinite(Number(loc[key])))) return false;
        if (spot?.raidBoss === true) {
            return !!spot.center
                && distance2d(spot.center, loc) <= 1200
                && Math.abs(Number(spot.center.locZ) - Number(loc.locZ)) <= 500;
        }
        // Non-grid profiles are used by callers with their own routing geometry.
        if (!GRID_SPOT_ID.test(String(spot?.id || ''))) return true;
        // A copy without its pieces (a session's spot) reads the catalogue's.
        const own = spot.floor || spot.joins ? spot : SpotIndex.spotById(this.spots, spot.id) || spot;
        return SpotIndex.covers(own, cellAt(loc).key, Number(loc.locZ));
    },

    assignSpot(session, spot) {
        if (!spot) return null;
        const moved = spot.id !== session.currentSpot?.id;
        session.currentSpot = {
            id: spot.id,
            name: spot.name,
            center: { ...spot.center },
            minLevel: spot.minLevel,
            maxLevel: spot.maxLevel,
            avgLevel: spot.avgLevel,
            density: spot.density,
            npcNames: [...spot.npcNames],
            tags: [...(spot.tags || [])],
            tagsAuthoritative: spot.tagsAuthoritative === true,
            area: spot.area ? { ...spot.area } : null,
            // Catalogue pieces, never written (containsLocation).
            floor: spot.floor || null,
            joins: spot.joins || null,
            route: spot.route || null
        };
        // The arrival after the choice is the same spot: no second post. The post is the
        // spot aggregate's arrival on the background thread (its hot arrival hook).
        // lazy: cycle BotLifeState invokes SpotService at its top.
        if (moved) invoke('GameServer/Bot/Population/BotLifeState').notifyNearFacts(session, 'near_spot');
        return session.currentSpot;
    },

    // The body leaves its spot (a respawn in town, a karma reset, a clan hall
    // departure): its post tells the background thread's spot aggregate it left
    // (near_left, spotId null). One with no spot posts nothing.
    leaveSpot(session) {
        const had = session.currentSpot != null;
        session.currentSpot = null;
        if (had) invoke('GameServer/Bot/Population/BotLifeState').notifyNearFacts(session, 'near_left');
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
        const angle = ((angleHash % 360) * Math.PI) / 180;
        const radius = 96 + (radiusHash % 161);
        // Offset and geodata height can leave a dungeon even inside the same
        // X/Y grid. Fall back to a known spawn on that layer, never its surface.
        for (let i = 0; i < Math.min(points.length, 8); i++) {
            const anchor = points[(anchorHash + i) % points.length];
            const point = constrainToSpotGrid(spot, anchor,
                Math.round(Number(anchor.locX) + Math.cos(angle) * radius),
                Math.round(Number(anchor.locY) + Math.sin(angle) * radius));
            const offset = { ...point, locZ: GeodataEngine.getHeight(point.locX, point.locY, Number(anchor.locZ)) };
            if (this.containsLocation(spot, offset)) return offset;
            const grounded = { ...anchor, locZ: GeodataEngine.getHeight(anchor.locX, anchor.locY, anchor.locZ) };
            if (this.containsLocation(spot, grounded)) return grounded;
            if (this.containsLocation(spot, anchor)) return { ...anchor };
        }
        return null;
    },

    arrivalPointsForParty(members, spot) {
        const anchor = this.arrivalPointForState(members[0], spot);
        if (!anchor) return null;
        const shared = { ...spot, arrivalPoints: [anchor] };
        const result = {};
        for (const member of members) {
            const point = this.arrivalPointForState(member, shared);
            // The spread keeps the group on the anchor's dungeon floor: a
            // point more than 100 above or below it would be another floor.
            // Open hilly ground fails the same test on a slope, and the
            // offset is hashed from the member's identity, so the party would
            // never get destinations. Such a member stands on the anchor
            // itself, which is on the right floor by construction.
            const compact = point && Math.hypot(point.locX - anchor.locX, point.locY - anchor.locY) <= 400
                && Math.abs(point.locZ - anchor.locZ) <= 100;
            result[String(member.characterId)] = compact ? point : { ...anchor };
        }
        return result;
    },

    describe(spot) {
        if (!spot) return 'unknown spot';
        return `${spot.name} (Lv ${spot.minLevel}-${spot.maxLevel}, density ${spot.density})`;
    },

    MIN_ELIGIBLE_DENSITY,
    distance2d,
    eligibleDensity,
    levelMix,
    huntBand,
    isSuitable,
    levelFit,
    locFromActor
};

module.exports = SpotService;
