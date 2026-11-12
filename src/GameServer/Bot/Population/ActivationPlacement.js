const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const PartyHuntingTarget = invoke('GameServer/Bot/Population/PartyHuntingTarget');
const TownTransitPolicy = invoke('GameServer/Bot/AI/TownTransitPolicy');

// A walker shown on its road (HotActivation) stands within ROAD_RADIUS of its road
// point; a point off the ground is stepped back toward the run's start in at most
// ROAD_STEPS equal steps, the last one the start itself (a teleport point or where it
// set out). A road point still in the town the run began in is shown at the run's start:
// the straight line leaves a town through its walls, into yards no street reaches. Our
// choice: the run is a straight line until roads exist.
const ROAD_RADIUS = 300;
const ROAD_STEPS = 12;
// A hunter shown on its held spot stands by the mobs it hunts, as a C4 player stands
// by the mobs he farms: MOB_NEAR..MOB_FAR from a live mob of the species its unit
// competes for, in sight of it, inside its spot, never within BODY_GAP of another
// body. The mobs: of that species within MOB_SCAN of its cold place and MOB_FLOOR of
// its floor, the MOB_ANCHORS nearest; with none placed, within HUNTER_RADIUS of its cold
// place. Any other bot (in town, a raid, off its spot) is placed within the wider
// activationPlacementRadius, which leaves room past activationMinPlayerDistance from a
// player standing on its anchor. A group shown together (a party around its leader, a
// PvP encounter's sides around the first side's principal; resolveGroup) stands in one
// formation instead, never by its hunted mobs: its lead body on its own place (within
// LEAD_RADIUS, else activationPlacementRadius), every other body within GROUP_RADIUS of
// where the lead stands. Placed one by one, two bodies around one point stand up to
// twice activationPlacementRadius apart, two hunters by their own mobs up to MOB_SCAN
// apart, and the group's caller refuses the whole group. Our choice. Temporary: until the territory rework places the cold
// place and the body by territory.
const MOB_NEAR = 150;
const MOB_FAR = 400;
const BODY_GAP = 100;
const MOB_SCAN = 6000;
const MOB_FLOOR = 500;
const MOB_ANCHORS = 4;
const HUNTER_RADIUS = 600;
const LEAD_RADIUS = 240;
const GROUP_RADIUS = 420;
const GROUP_FLOOR = 500;
// Grounding (floor): down to FLOOR_BELOW, up to PLACE_ABOVE for a stored place and
// ROAD_ABOVE for a road point; a neighbouring cell within CELL_STEP of its centre's
// height. A place on a spot off the ground recovers at one of the SPOT_RALLIES spawn
// points nearest it (spotRally).
const FLOOR_BELOW = 500;
const PLACE_ABOVE = 64;
const ROAD_ABOVE = 500;
const CELL_STEP = 64;
const SPOT_RALLIES = 8;

function finiteLocation(loc) {
    return !!loc && ['locX', 'locY', 'locZ'].every((key) =>
        loc[key] !== null && loc[key] !== undefined && String(loc[key]).trim() !== ''
        && Number.isFinite(Number(loc[key])));
}

function distance(a, b) {
    return Math.hypot(a.locX - b.locX, a.locY - b.locY);
}

// The ground under a point, the one grounding of every placed point (a cold place, a
// road step, a sample, a raid's boss and its arrivals): the geodata layer nearest the
// point's height within `below` under it and `above` over it, walkable. A stored place
// grounds down as far as FLOOR_BELOW (a C4 spawn height above its terrain) and up only
// PLACE_ABOVE, never onto a roof; a walker's road point, a straight line over hills and
// hollows, ROAD_ABOVE. Our choice.
function floor(loc, above, below = FLOOR_BELOW) {
    if (!finiteLocation(loc)) return null;
    const locX = Math.round(Number(loc.locX)), locY = Math.round(Number(loc.locY)), locZ = Number(loc.locZ);
    // getCellData loads the region; hasGeo alone only checks the loaded cache.
    let cell = Geo.getCellData(locX, locY, locZ);
    if (!Geo.hasGeo(locX, locY)) return null;
    // The nearest layer is over the window (a roof): the floor under it is the layer
    // nearest the point mirrored below by the roof's gap (the layer right under the point
    // whenever it lies within three times that gap), else the layer nearest the middle of
    // the window's lower half.
    if (cell.z > locZ + above) {
        const under = Geo.getCellData(locX, locY, 2 * locZ - cell.z);
        cell = under.z <= locZ + above && under.z >= locZ - below ? under : Geo.getCellData(locX, locY, locZ - below / 2);
    }
    if (!cell.nswe || !Number.isFinite(cell.z) || cell.z > locZ + above || cell.z < locZ - below) return null;
    return { locX, locY, locZ: cell.z };
}

function connected(from, to) {
    // A body walks from one to the other and back: the straight walk is asked
    // each way, since a cell may open onto a neighbour that does not open back
    // (a steep slope, a ledge, a tree's skirt). Our choice: a body is shown
    // only where one could also have walked to.
    return Geo.hasLineOfSight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ)
        && Geo.hasLineOfSight(to.locX, to.locY, to.locZ, from.locX, from.locY, from.locZ);
}

// A floor point a body can stand on: one geodata cell of room around it, rather than
// a point pressed into a wall or inside a blocked cell.
function clear(center) {
    if (!center) return null;
    for (const [dx, dy] of [[16, 0], [-16, 0], [0, 16], [0, -16]]) {
        const edge = floor({ locX: center.locX + dx, locY: center.locY + dy, locZ: center.locZ }, CELL_STEP, CELL_STEP);
        if (!edge || !connected(center, edge)) return null;
    }
    return center;
}

function ground(loc, above) {
    return clear(floor(loc, above));
}

// A walker's road point (ColdTrip.positionAt, a straight-line estimate) off the ground:
// the first step back toward `from` (where its run began) a body can stand on.
function roadStepBack(loc, from) {
    for (let i = 1; i <= ROAD_STEPS; i++) {
        const t = i / ROAD_STEPS;
        const point = ground({ locX: Number(loc.locX) + (Number(from.locX) - Number(loc.locX)) * t,
            locY: Number(loc.locY) + (Number(from.locY) - Number(loc.locY)) * t,
            locZ: Number(loc.locZ) + (Number(from.locZ) - Number(loc.locZ)) * t }, ROAD_ABOVE);
        if (point) return point;
    }
    return null;
}

// A place on a spot off the ground: the spot's spawn point nearest it that passes
// `stands` (the SPOT_RALLIES nearest), else, outside a raid, the spot's centre. A raid
// never rallies on its boss's own place.
function spotRally(spot, loc, stands) {
    const points = (spot.arrivalPoints || []).filter(finiteLocation)
        .map(point => ({ point, gap: distance(point, loc) }))
        .sort((a, b) => a.gap - b.gap).slice(0, SPOT_RALLIES).map(entry => entry.point);
    if (spot.raidBoss !== true && spot.center) points.push(spot.center);
    for (const point of points) {
        const rally = stands(point);
        if (rally) return rally;
    }
    return null;
}

// A bot on its held grid spot; not one off it (in town, on a road).
function onHeldSpot(state, spot) {
    return !!spot && spot.raidBoss !== true && Array.isArray(spot.npcEntries)
        && SpotService.containsLocation(spot, state.loc);
}

// The live mobs a hunter on its held grid spot is shown by: of the species its unit
// competes for (PartyHuntingTarget.competitionNpcId, the one the background thread
// contests on), inside the spot.
function huntedMobs(state, spot) {
    const npcId = PartyHuntingTarget.competitionNpcId(null, state, spot);
    if (!npcId) return [];
    const from = { locX: Number(state.loc.locX), locY: Number(state.loc.locY), locZ: Number(state.loc.locZ) };
    const mobs = [];
    for (const npc of invoke('GameServer/World/World').fetchNpcsInRadius(from.locX, from.locY, MOB_SCAN)) {
        if (Number(npc.fetchSelfId?.()) !== npcId || npc.isDead?.()) continue;
        const loc = { locX: npc.fetchLocX(), locY: npc.fetchLocY(), locZ: npc.fetchLocZ() };
        if (Math.abs(loc.locZ - from.locZ) <= MOB_FLOOR && SpotService.containsLocation(spot, loc)) mobs.push(loc);
    }
    return mobs.sort((a, b) => distance(a, from) - distance(b, from)).slice(0, MOB_ANCHORS);
}

function crowded(loc) {
    return invoke('GameServer/World/World').actorSessionsNear(loc, BODY_GAP).length > 0;
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
    const raid = !fixed && !summoned && savedSpot?.raidBoss === true;
    const player = options.playerLoc;
    if (player && !finiteLocation(player)) return null;
    if (fixed) {
        const loc = ground(source, PLACE_ABOVE);
        return loc ? { loc, spot: SpotService.findCurrentSpot(loc) || null } : null;
    }
    // A raid body stands inside the raid's area on ground connected to the boss's floor:
    // a height-valid place can still be against a cliff or behind a wall from the boss.
    const bossFloor = raid ? floor(savedSpot.center, PLACE_ABOVE) : null;
    if (raid && !bossFloor) return null;
    const rally = (point) => {
        const loc = ground(point, PLACE_ABOVE);
        return loc && SpotService.containsLocation(savedSpot, loc) && connected(bossFloor, loc) ? loc : null;
    };
    // A walker still in the town its run began in has not left it: shown at the run's start.
    const startTown = road && finiteLocation(source) && finiteLocation(options.roadFrom)
        ? TownTransitPolicy.townAt(options.roadFrom) : null;
    const inStartTown = !!startTown && TownTransitPolicy.townAt(source) === startTown;
    // A walker that has just landed by teleport (its run began at the landing) is shown
    // there even beside a player, as C4 shows a teleport arrival; a summoned bot by him.
    const landing = road && options.roadFromLanding === true
        && (inStartTown || distance(source, options.roadFrom) <= ROAD_RADIUS);
    const nearest = summoned || landing ? 0 : Config.activationMinPlayerDistance;
    // A sample grounds at its anchor's height, within FLOOR_BELOW either way; the ray
    // from the anchor proves it stands on the anchor's floor.
    const acceptable = (point, from) => {
        if (player) {
            const dist = distance(point, player);
            if (dist < nearest || dist > Config.activationRadius) return null;
        }
        const loc = ground(point, FLOOR_BELOW);
        if (!loc || (raid && !SpotService.containsLocation(savedSpot, loc)) || !connected(from, loc)) return null;
        return { loc, spot: SpotService.findCurrentSpot(loc) || null };
    };
    // A hunter on its held spot, shown alone: by a mob it hunts; else around its cold place
    // below. A body of a group, a raid, a walker and a summoned bot are placed around
    // their anchor.
    const onSpot = !summoned && !raid && !road && onHeldSpot(state, savedSpot);
    const hunter = onSpot && options.group !== true;
    const mobs = hunter ? huntedMobs(state, savedSpot) : [];
    for (let i = 0; mobs.length && i < Config.activationPlacementAttempts; i++) {
        const mob = floor(mobs[i % mobs.length], PLACE_ABOVE);
        if (!mob) continue;
        const angle = Math.random() * Math.PI * 2;
        const radius = MOB_NEAR + Math.random() * (MOB_FAR - MOB_NEAR);
        const placement = acceptable({ locX: Math.round(mob.locX + Math.cos(angle) * radius),
            locY: Math.round(mob.locY + Math.sin(angle) * radius), locZ: mob.locZ }, mob);
        if (placement && SpotService.containsLocation(savedSpot, placement.loc) && !crowded(placement.loc)) {
            return { loc: placement.loc, spot: savedSpot };
        }
    }
    const placementRadius = Math.max(0, Number(options.placementRadius
        ?? (road ? ROAD_RADIUS : hunter ? HUNTER_RADIUS : Config.activationPlacementRadius)) || 0);
    const around = (anchor) => {
        if (summoned) {
            for (const radius of [48, 80, 128, 192, 256]) {
                for (let i = 0; i < 8; i++) {
                    const angle = i * Math.PI / 4;
                    const placement = acceptable({ locX: Math.round(anchor.locX + Math.cos(angle) * radius),
                        locY: Math.round(anchor.locY + Math.sin(angle) * radius), locZ: anchor.locZ }, anchor);
                    if (placement) return placement;
                }
            }
        }
        if (options.preferAnchor === true) {
            const placement = acceptable(anchor, anchor);
            if (placement) return placement;
        }
        for (let i = 0; i < Config.activationPlacementAttempts; i++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * placementRadius;
            const placement = acceptable({ locX: Math.round(anchor.locX + Math.cos(angle) * radius),
                locY: Math.round(anchor.locY + Math.sin(angle) * radius), locZ: anchor.locZ }, anchor);
            if (placement) return placement;
        }
        // Never replace an exhausted search with an unchecked displacement.
        return acceptable(anchor, anchor);
    };
    if (inStartTown) {
        const start = ground(options.roadFrom, PLACE_ABOVE);
        const placement = start && around(start);
        if (placement) Metrics.recordWalkerStartTownPlacement();
        return placement;
    }
    // A place a body cannot stand on recovers where the bot can be: a walker on the first
    // ground stepped back along its road, a raid body or a bot on its spot at the spot's
    // nearest spawn point that stands inside the spot. Without one (a bot in town, a group member around
    // its lead off a raid) the place's floor is sampled around as it is. Each recovery
    // that places a body is counted by kind.
    const recovery = road ? (finiteLocation(options.roadFrom) ? 'road' : null)
        : raid || (onSpot && options.aroundLead !== true) ? 'spot' : null;
    let anchor = raid ? rally(source) : floor(source, road ? ROAD_ABOVE : PLACE_ABOVE);
    if (anchor && recovery && !raid && !clear(anchor)) anchor = null;
    if (anchor || !recovery) return anchor ? around(anchor) : null;
    anchor = recovery === 'road' ? roadStepBack(source, options.roadFrom)
        : finiteLocation(source) ? spotRally(savedSpot, source, raid ? rally : (point) => {
            const loc = ground(point, PLACE_ABOVE);
            return loc && SpotService.containsLocation(savedSpot, loc) ? loc : null;
        }) : null;
    const placement = anchor && around(anchor);
    if (placement) {
        if (recovery === 'road') Metrics.recordWalkerRoadStepBack();
        else Metrics.recordSpotPlaceRecovery();
    }
    return placement;
}

// Where each of `states` stands when the group turns hot together, the lead body at
// `leadIndex` first; null when one has no place or stands more than `spread` from the
// lead (or off its floor), as the caller then keeps the whole group cold. The lead
// stands within LEAD_RADIUS of its place, else (a player on it) within the wider
// activationPlacementRadius. Through the exported resolve, which tests stand in for.
function resolveGroup(states, leadIndex, options, spread) {
    const lead = module.exports.resolve(states[leadIndex],
        { ...options, group: true, preferAnchor: true, placementRadius: LEAD_RADIUS })
        || module.exports.resolve(states[leadIndex], { ...options, group: true });
    if (!lead) return null;
    const placements = states.map((state, index) => index === leadIndex ? lead
        : module.exports.resolve({ ...state, loc: lead.loc },
            { ...options, group: true, aroundLead: true, placementRadius: GROUP_RADIUS }));
    return placements.every(p => p && distance(p.loc, lead.loc) <= spread
        && Math.abs(p.loc.locZ - lead.loc.locZ) <= GROUP_FLOOR) ? placements : null;
}

module.exports = { resolve, resolveGroup };
