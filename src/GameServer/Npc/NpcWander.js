const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Response = invoke('GameServer/Network/Response');
const TownGuard = invoke('GameServer/Npc/TownGuard');
const PlayerActivitySignal = require('../Bot/Population/PlayerActivitySignal');
const { NPC_GRID_SIZE, inClientView } = require('../World/WorldConstants');
const source = require('../../../data/Npcs/wander-exclusions.json');

// Lisvus fdc7e33a: thinkActive every second, RANDOM_WALK_RATE=30,
// Options.properties MaxDriftRange=200 (the Config.java fallback is 300).
const WALK_RATE = 30;
const DRIFT_RANGE = 200;
const MAX_GEO_CHECKS = 32;
const MAX_ACTIVE_WALKS = 128;
const MAX_STEP_DISTANCE = DRIFT_RANGE * 2;
const excludedIds = new Set(Object.values(source.groups).flat());
const territoryBoxes = new WeakMap();
const walksByWorld = new WeakMap();
const homeTeleports = { unseen: 0, blocked: 0 };

function activeWalks(world) {
    let active = walksByWorld.get(world.npc);
    if (!active) walksByWorld.set(world.npc, active = new Set());
    return active;
}

function eligible(npc) {
    return npc?.fetchKind?.() === 'Monster' && !!npc.spawnDefinition
        && !excludedIds.has(Number(npc.fetchSelfId()))
        && !npc.fetchIsRaidBoss?.() && !npc.fetchIsSummon?.() && !npc.fetchIsPet?.()
        && !npc.minionGroup && !npc.minionLeader && !npc.minionBossObjectId
        && !npc.questSpawn && !npc.model?.questMonster && !npc.model?.isQuestMonster
        && String(npc.fetchTitle?.() || '').toLowerCase() !== 'quest monster'
        && !TownGuard.isTownGuard(npc)
        && !npc.state.fetchDead() && !npc.state.fetchCombats()
        && !npc.state.inMotion() && !npc.state.isBlocked()
        && !npc.fetchStateInvisible?.() && Number(npc.fetchWalkSpd()) > 0;
}

function coords(npc) {
    return { locX: npc.fetchLocX(), locY: npc.fetchLocY(), locZ: npc.fetchLocZ() };
}

function inside(point, bounds) {
    let result = false;
    for (let i = 0, j = bounds.length - 1; i < bounds.length; j = i++) {
        const a = bounds[i], b = bounds[j];
        if ((a.locY > point.locY) !== (b.locY > point.locY)
            && point.locX < (b.locX - a.locX) * (point.locY - a.locY) / (b.locY - a.locY) + a.locX) result = !result;
    }
    return result;
}

function cross(a, b, c) {
    return (b.locX - a.locX) * (c.locY - a.locY) - (b.locY - a.locY) * (c.locX - a.locX);
}

function crossesBoundary(from, to, bounds) {
    // Endpoints alone are insufficient for a concave territory.
    return bounds.some((a, i) => {
        const b = bounds[(i + 1) % bounds.length];
        return cross(from, to, a) * cross(from, to, b) < 0
            && cross(a, b, from) * cross(a, b, to) < 0;
    });
}

function limitStep(from, to, maxDistance) {
    const distance = Math.hypot(to.locX - from.locX, to.locY - from.locY);
    const ratio = Math.min(1, maxDistance / Math.max(1, distance));
    return { locX: Math.round(from.locX + (to.locX - from.locX) * ratio),
        locY: Math.round(from.locY + (to.locY - from.locY) * ratio), locZ: from.locZ };
}

// Real players only: bots do not watch monsters, so one out of a player's view
// can go home at once, and one a player watches walks.
function realObservers(world) {
    return (world.user?.sessions || []).filter(PlayerActivitySignal.isRealPlayerSession);
}

function seesNpc(actor, npc) {
    return inClientView(actor.fetchLocX(), actor.fetchLocY(), npc.fetchLocX(), npc.fetchLocY());
}

// A floor above or below does not count as watching a monster walk.
function inView(actor, npc) {
    return seesNpc(actor, npc) && Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) <= 400;
}

function sendToWatchers(npc, observers, packet) {
    for (const session of observers) {
        const actor = session.actor;
        if (actor?.fetchIsOnline?.() !== true || typeof session.dataSendToMe !== 'function') continue;
        if (session.knownNpcIds && !session.knownNpcIds.has(npc.fetchId())) continue;
        if (seesNpc(actor, npc)) session.dataSendToMe(packet);
    }
}

function homeOf(npc) {
    const home = npc.spawnDefinition?.spawn?.coords?.length ? npc.spawnOrigin || npc.spawnDefinition.spawn.coords[0] : null;
    return home && [home.locX, home.locY, home.locZ].every(Number.isFinite) ? home : null;
}

// A monster that a fight left beyond its drift range (or outside its
// territory) walks back home on every tick, not by the random-walk roll
// (Mobius C4 AttackableAI.thinkActive: returnHome while it has no target or
// its target is a dead player; AttackablesCampPlayerCorpses = False).
function awayFromHome(npc, from = coords(npc)) {
    const home = homeOf(npc);
    if (home) return Math.hypot(from.locX - home.locX, from.locY - home.locY) > DRIFT_RANGE * 2;
    const bounds = npc.spawnDefinition?.bounds;
    return Array.isArray(bounds) && bounds.length >= 3 && !inside(from, bounds);
}

function destination(npc, random = Math.random) {
    const from = coords(npc);
    const { spawn, bounds } = npc.spawnDefinition;
    if (spawn.coords?.length) {
        const home = homeOf(npc);
        if (!home) return null;
        const outside = awayFromHome(npc, from);
        const to = outside ? home : {
            locX: home.locX + Math.floor(random() * DRIFT_RANGE * 2) - DRIFT_RANGE,
            locY: home.locY + Math.floor(random() * DRIFT_RANGE * 2) - DRIFT_RANGE
        };
        // Return toward home in short steps too: no long synchronous geo ray
        // or A* just because a player dragged a mob across the map.
        return limitStep(from, to, MAX_STEP_DISTANCE);
    }
    if (!Array.isArray(bounds) || bounds.length < 3) return null;
    let box = territoryBoxes.get(bounds);
    if (!box) {
        if (!bounds.every((p) => Number.isFinite(p.locX) && Number.isFinite(p.locY))) return null;
        box = { minX: Math.min(...bounds.map(p => p.locX)), maxX: Math.max(...bounds.map(p => p.locX)),
            minY: Math.min(...bounds.map(p => p.locY)), maxY: Math.max(...bounds.map(p => p.locY)) };
        territoryBoxes.set(bounds, box);
    }
    // Bounded rejection sampling. A thin/malformed polygon may skip a walk;
    // it must never trap the game loop looking for a random point.
    for (let attempt = 0; attempt < 8; attempt++) {
        const point = { locX: box.minX + random() * (box.maxX - box.minX),
            locY: box.minY + random() * (box.maxY - box.minY) };
        if (!inside(point, bounds)) continue;
        const to = limitStep(from, point, DRIFT_RANGE);
        if (inside(from, bounds) && (!inside(to, bounds) || crossesBoundary(from, to, bounds))) continue;
        return to;
    }
    return null;
}

function teleportHome(npc, world, observers) {
    // A leader does not leave its minions: nothing else brings them back.
    if (npc.minionState) return false;
    const origin = npc.spawnOrigin;
    const home = homeOf(npc) || (origin && [origin.locX, origin.locY, origin.locZ].every(Number.isFinite) ? origin : null);
    if (!home) return false;
    const to = { locX: home.locX, locY: home.locY, locZ: home.locZ };
    sendToWatchers(npc, observers, Response.teleportToLocation(npc.fetchId(), { ...to, head: npc.fetchHead() }));
    npc.setLocXYZ(to);
    if (world.npc?.gridKeys?.has(npc)) world.addNpcToGrid(npc);
    // A player near home never knew this monster.
    invoke('GameServer/World/Generics/SpawnNpcs').notifyNearby(world, npc); // lazy: cycle SpawnNpcs loads Npc, which loads this file.
    return true;
}

// A monster that left a fight away from home with no real player in view is
// back at once: nobody sees it, and no tick walks a mob no player is near.
function leaveFight(npc, world = invoke('GameServer/World/World')) { // lazy: cycle World loads Npc, which loads this file.
    if (!eligible(npc) || !Restrictions.canMove(npc) || !awayFromHome(npc)) return false;
    const observers = realObservers(world);
    if (observers.some(session => inView(session.actor, npc))) return false;
    const sent = teleportHome(npc, world, observers);
    if (sent) homeTeleports.unseen += 1;
    return sent;
}

function start(npc, world, observers, random = Math.random) {
    if (!eligible(npc) || !Restrictions.canMove(npc) || !Restrictions.canUseBasicAction(npc)
        || npc.fetchMostHated?.()) return false;
    const active = activeWalks(world);
    if (active.size >= MAX_ACTIVE_WALKS) return false;
    const speed = npc.fetchCollectiveWalkSpd();
    if (!Number.isFinite(speed) || speed <= 0) return false;
    const from = coords(npc);
    const to = destination(npc, random);
    // A way home that is blocked ends in a teleport (Mobius C4 sends a monster
    // back that way): this never queues pathfinding work for an idle monster.
    const blocked = () => {
        const sent = awayFromHome(npc, from) && teleportHome(npc, world, observers);
        if (sent) homeTeleports.blocked += 1;
        return sent;
    };
    if (!to) return blocked();
    if (Math.hypot(to.locX - from.locX, to.locY - from.locY) < 16) return false;
    // Cosmetic movement fails closed in uncovered regions. This never loads
    // regions on behalf of an idle monster.
    if (!Geodata.hasGeo(from.locX, from.locY) || !Geodata.hasGeo(to.locX, to.locY)) return blocked();
    to.locZ = Geodata.getHeight(to.locX, to.locY, from.locZ);
    if (!Number.isFinite(to.locZ) || !Geodata.hasLineOfSight(
        from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ)) return blocked();

    const transport = { dataSendToMeAndOthers(packet) { sendToWatchers(npc, observers, packet); } };
    const wasRunning = npc.fetchStateRun();
    npc.setStateRun(false);
    if (wasRunning) transport.dataSendToMeAndOthers(Response.walkAndRun(npc.fetchId(), false));
    const npcWorld = world.npc;
    let key = `${Math.floor(from.locX / NPC_GRID_SIZE)}_${Math.floor(from.locY / NPC_GRID_SIZE)}`;
    const started = npc.automation.scheduleMoveToCoords(transport, npc, to, () => active.delete(npc), {
        speed, towards: 'wander', onPosition() {
            if (world.npc !== npcWorld || !npcWorld.gridKeys?.has(npc)) return;
            const next = `${Math.floor(npc.fetchLocX() / NPC_GRID_SIZE)}_${Math.floor(npc.fetchLocY() / NPC_GRID_SIZE)}`;
            if (next !== key) {
                world.addNpcToGrid(npc);
                key = next;
            }
        }
    });
    if (started) active.add(npc);
    return started;
}

function cancel(npc, session) {
    if (npc.state?.fetchTowards?.() !== 'wander') return false;
    npc.automation.abortMovement(npc, { notifyClient: false });
    npc.stopForCombatAction(session);
    return true;
}

function tick(world, { random = Math.random } = {}) {
    if (!world?.npc?.grid) return 0;
    const active = activeWalks(world);
    // Root, death and despawn use the ordinary automation cancellation. Drop
    // their bookkeeping on this shared tick, including when all players left.
    for (const npc of active) if (npc.state.fetchTowards() !== 'wander'
        || !world.npc.gridKeys?.has(npc)) active.delete(npc);
    if (active.size >= MAX_ACTIVE_WALKS) return 0;
    const observers = realObservers(world);
    if (!observers.length) return 0;
    // Union the nine sectors around each observer. Crowded areas are scanned
    // once, without touching npc.spawns or multiplying work by nearby bots.
    const cells = new Map();
    for (const session of observers) {
        const actor = session.actor;
        const gx = Math.floor(actor.fetchLocX() / NPC_GRID_SIZE), gy = Math.floor(actor.fetchLocY() / NPC_GRID_SIZE);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const key = `${gx + dx}_${gy + dy}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(actor);
        }
    }
    let rolled = 0;
    const requests = [];
    for (const [key, actors] of cells) for (const npc of world.npc.grid[key] || []) {
        if (!eligible(npc) || !actors.some(actor => inView(actor, npc))) continue;
        if (!awayFromHome(npc) && Math.floor(random() * WALK_RATE) !== 0) continue;
        // Reservoir sampling gives later sectors the same chance under load.
        // At most 32 short geo rays / new movements per shared one-second tick.
        rolled++;
        if (requests.length < MAX_GEO_CHECKS) requests.push(npc);
        else {
            const index = Math.floor(random() * rolled);
            if (index < MAX_GEO_CHECKS) requests[index] = npc;
        }
    }
    return requests.reduce((count, npc) => count + Number(start(npc, world, observers, random)), 0);
}

// Monsters sent home at once: unseen at a fight's end, or with a blocked way (status line).
function homeTeleportStats() {
    return { ...homeTeleports };
}

module.exports = { tick, eligible, destination, start, leaveFight, cancel, homeTeleportStats, WALK_RATE, DRIFT_RANGE, MAX_GEO_CHECKS, MAX_ACTIVE_WALKS };
