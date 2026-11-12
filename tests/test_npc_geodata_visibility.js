const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

(async () => {

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');

const originalGetCellData = GeodataEngine.getCellData;
const originalReadCell = GeodataEngine.readCell;
const originalHasGeo = GeodataEngine.hasGeo;
const originalHasLineOfSight = GeodataEngine.hasLineOfSight;
const originalCanWalkStraight = GeodataEngine.canWalkStraight;
const originalFindPath = GeodataEngine.findPath;

// A synthetic map for both readers of a cell: getCellData (the walk and the
// route search) and readCell (sight). cellAt(cx, cy) gives the cell's layers
// as [{ z, nswe }] and whether a town obstacle covers it.
function useMap(cellAt) {
    GeodataEngine.getCellData = (x, y, z) => {
        const cell = cellAt(x >> 4, y >> 4);
        if (cell.closed) return { z, nswe: 0 };
        let best = cell.layers[0];
        for (const layer of cell.layers) if (Math.abs(layer.z - z) < Math.abs(best.z - z)) best = layer;
        return { z: best.z, nswe: best.nswe };
    };
    GeodataEngine.readCell = (cx, cy, slot) => {
        const cell = cellAt(cx, cy);
        slot.closed = !!cell.closed;
        slot.n = cell.layers.length;
        cell.layers.forEach((layer, l) => { slot.z[l] = layer.z; slot.nswe[l] = layer.nswe; });
        return slot;
    };
}
const flat = (z, nswe = 15) => ({ layers: [{ z, nswe }] });

GeodataEngine.hasGeo = () => true;
useMap(() => ({ layers: [{ z: -12096, nswe: 15 }, { z: -9056, nswe: 15 }] }));

assert.strictEqual(
    GeodataEngine.hasLineOfSight(8, 8, -12096, 8, 8, -9056),
    false,
    'multilevel cells at the same XY coordinate must not see through the floor'
);
assert.strictEqual(
    GeodataEngine.hasLineOfSight(8, 8, -12096, 40, 8, -9056),
    false,
    'nearby coordinates resolved to different geodata layers must not have line of sight'
);
assert.strictEqual(
    GeodataEngine.hasLineOfSight(8, 8, -12096, 40, 8, -12096),
    true,
    'an unobstructed line on the same geodata layer must remain visible'
);
assert.strictEqual(
    GeodataEngine.findPath(8, 8, -12096, 8, 8, -9056),
    null,
    'pathfinding must not convert an overlapping XY cell into a vertical teleport between floors'
);

useMap(() => ({ layers: [{ z: 0, nswe: 15 }, { z: 64, nswe: 15 }] }));
assert.strictEqual(
    GeodataEngine.hasLineOfSight(8, 8, 0, 8, 8, 64),
    false,
    'distinct layers in the same geocell must remain separated even when their Z delta is walkable'
);
assert.strictEqual(
    GeodataEngine.findPath(8, 8, 0, 8, 8, 64),
    null,
    'same-cell pathfinding must not vertically snap between close multilevel layers'
);

useMap((cx) => cx === 0 ? flat(0, 14) : cx === 1 ? flat(0, 13) : flat(0)); // a wall between cells 0 and 1
assert.strictEqual(
    GeodataEngine.canWalkStraight(8, 8, 0, 24, 8, 0),
    false,
    'NSWE walls must block a straight walk between adjacent cells'
);
// C4 sight asks the sides only to pick a cell's layer: a wall the map draws
// only as closed sides at ground height does not hide.
useMap((cx) => cx === 5 ? flat(0, 14) : cx === 6 ? flat(0, 13) : flat(0));
assert.strictEqual(GeodataEngine.hasLineOfSight(8, 8, 0, 168, 8, 0), true,
    'a wall drawn only as closed sides at ground height does not hide');
assert.strictEqual(GeodataEngine.hasLineOfSight(168, 8, 0, 8, 8, 0), true, 'from either side');
assert.strictEqual(GeodataEngine.canWalkStraight(8, 8, 0, 168, 8, 0), false, 'but nobody walks through it');

// A low skirt is seen over and not walked; a trunk hides.
{
    const row = (skirtZ) => useMap((cx) => cx === 4 ? flat(0, 14) // no east side: nobody walks in
        : cx === 5 || cx === 6 ? flat(skirtZ, 4) // the skirt opens downhill (south) only
            : flat(0));
    row(24);
    const west = [8, 8, 0], east = [(12 << 4) + 8, 8, 0];
    assert.strictEqual(GeodataEngine.hasLineOfSight(...west, ...east), true, 'a body sees another over a skirt raised 24');
    assert.strictEqual(GeodataEngine.hasLineOfSight(...east, ...west), true, 'and is seen back');
    assert.strictEqual(GeodataEngine.canWalkStraight(...west, ...east), false, 'nobody walks over the skirt eastward');
    assert.strictEqual(GeodataEngine.canWalkStraight(...east, ...west), false, 'nor westward');
    row(200);
    assert.strictEqual(GeodataEngine.hasLineOfSight(...west, ...east), false, 'a trunk raised 200 hides');
    assert.strictEqual(GeodataEngine.hasLineOfSight(...east, ...west), false, 'either way');
}

// Diagonal corners as Lisvus GeoData.canSeeTarget asks them: the north corner
// with the left cell's east side. The start (2,2) has no north side and the
// east corner (3,2) lies 40 lower, so the north-east line is not seen; Mobius,
// asking each corner its own side, would see it.
{
    useMap((cx, cy) => cx === 2 && cy === 2 ? flat(0, 7) : cx === 3 && cy === 2 ? flat(-40) : flat(0));
    const at = (cx, cy) => [(cx << 4) + 8, (cy << 4) + 8, 0];
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(2, 2), ...at(6, -2)), false,
        'a diagonal past a cell with no side toward its corner is not seen (Lisvus corner flags)');
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(6, -2), ...at(2, 2)), false, 'from either end');
}

// A body inside a town obstacle (a building missing from the map) is neither
// seen nor seeing, at any distance; the open control is seen.
{
    useMap((cx, cy) => ({ ...flat(0), closed: cx === 10 && cy === 10 }));
    const at = (cx, cy) => [(cx << 4) + 8, (cy << 4) + 8, 0];
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(10, 10), ...at(11, 11)), false, 'a body in a building does not see one 30 away');
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(11, 11), ...at(10, 10)), false, 'nor is seen by it');
    assert.strictEqual(GeodataEngine.hasLineOfSight(168, 168, 0, 170, 170, 0), false, 'nor by one in the same building cell');
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(10, 10), ...at(22, 10)), false, 'nor 200 away');
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(22, 10), ...at(10, 10)), false, 'from either end');
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(12, 12), ...at(13, 13)), true, 'two bodies outside see each other');
}

// A tree as the map has it: the skirt cells open outward (downhill) only, the
// ground around them does not open into the skirt, the trunk is closed.
{
    const skirt = { '2,2': { z: 0, nswe: 6 }, '3,2': { z: 24, nswe: 6 } };
    const around = { '1,2': 14, '2,3': 7, '3,3': 7 }; // west of it: no east side; south of it: no north side
    const trunk = new Set(['2,1', '3,1', '4,2']);
    const ledge = { '8,8': 200 }; // a cell 200 above the ground round it
    useMap((cx, cy) => {
        const key = `${cx},${cy}`;
        if (trunk.has(key)) return flat(0, 0);
        if (skirt[key]) return flat(skirt[key].z, skirt[key].nswe);
        return flat(ledge[key] || 0, around[key] || 15);
    });
    const at = (cx, cy, z = 0) => [(cx << 4) + 8, (cy << 4) + 8, z];
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(2, 2), ...at(-3, 2)), true,
        'a body in the skirt sees one west of the tree');
    assert.strictEqual(GeodataEngine.hasLineOfSight(...at(-3, 2), ...at(2, 2)), true,
        'and the one west of it sees the body in the skirt: sight does not depend on who looks');
    assert.strictEqual(GeodataEngine.canWalkStraight(...at(-3, 2), ...at(2, 2)), false, 'though it cannot walk in');
    assert.strictEqual(GeodataEngine.canWalkStraight(...at(2, 2), ...at(0, 2)), true,
        'a body in a tree skirt walks out of it by the side its cell opens');
    const out = GeodataEngine.findPath(...at(2, 2), ...at(0, 6), 500);
    assert(out && out.length > 1, 'a body in a tree skirt has a route to the open ground');
    let from = { locX: 40, locY: 40, locZ: 0 };
    for (const to of out) {
        assert(GeodataEngine.canWalkStraight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ),
            'every leg of the route out is a straight walk the same rule allows');
        from = to;
    }
    assert(GeodataEngine.findPath(...at(3, 2, 24), ...at(0, 6), 500)?.length > 1, 'also from deeper in the skirt');
    assert.strictEqual(GeodataEngine.canWalkStraight(...at(0, 2), ...at(2, 2)), false, 'nobody walks into the skirt from the west');
    assert.strictEqual(GeodataEngine.canWalkStraight(...at(2, 5), ...at(2, 2)), false, 'nor from the south');
    assert.strictEqual(GeodataEngine.findPath(...at(0, 6), ...at(2, 2), 500), null, 'no route leads into the skirt');
    assert.strictEqual(GeodataEngine.canWalkStraight(...at(2, 0), ...at(2, 1)), false,
        'a closed cell is not entered although its neighbour opens toward it');
    assert.strictEqual(GeodataEngine.findPath(...at(0, 0), ...at(3, 1), 500), null, 'no route ends inside the trunk');
    assert.strictEqual(GeodataEngine.canWalkStraight(...at(8, 8, 200), ...at(9, 8)), false,
        'a step whose floor lies more than a layer step below is not taken');
    assert.strictEqual(GeodataEngine.canWalkStraight(...at(9, 8), ...at(8, 8, 200)), false, 'nor one that far above');
}

const heightMap = [
    [160, 128, 96, 128, 96],
    [32, 96, 32, 192, 32],
    [64, 192, 32, 32, 0],
    [64, 192, 64, 0, 0],
    [0, 0, 64, 32, 32]
];
const openMap = [
    [true, true, true, true, true],
    [true, true, false, true, true],
    [true, true, true, true, true],
    [true, true, true, true, true],
    [true, true, true, true, true]
];
GeodataEngine.getCellData = (x, y) => {
    const cx = x >> 4;
    const cy = y >> 4;
    if (!openMap[cy]?.[cx]) return { z: 0, nswe: 0 };

    let nswe = 0;
    if (openMap[cy]?.[cx + 1]) nswe |= 1;
    if (openMap[cy]?.[cx - 1]) nswe |= 2;
    if (openMap[cy + 1]?.[cx]) nswe |= 4;
    if (openMap[cy - 1]?.[cx]) nswe |= 8;
    return { z: heightMap[cy][cx], nswe };
};
GeodataEngine.canWalkStraight = (fromX, fromY, fromZ, toX, toY, toZ) => (
    Math.abs((fromX >> 4) - (toX >> 4)) + Math.abs((fromY >> 4) - (toY >> 4)) <= 1
    && Math.abs(fromZ - toZ) <= 64
);
const shortestLayeredPath = GeodataEngine.findPath(8, 8, 160, 72, 72, 32, 1000);
assert.strictEqual(
    shortestLayeredPath?.length,
    9,
    'the layered A* heuristic must preserve the shortest eight-step route'
);

GeodataEngine.getCellData = originalGetCellData;
GeodataEngine.readCell = originalReadCell;
GeodataEngine.hasGeo = originalHasGeo;
GeodataEngine.canWalkStraight = originalCanWalkStraight;

const crumaRegion = path.join(GeodataEngine.getGeodataDir(), '20_21.l2j');
if (process.env.L2NODE_SKIP_RAW_GEODATA_TESTS === '1') {
    console.log('SKIP: raw Cruma geodata checks are in npm run test:geodata');
} else if (fs.existsSync(crumaRegion)) {
    assert.strictEqual(
        GeodataEngine.hasLineOfSight(23741, 117274, -12089, 23765, 117288, -9047),
        false,
        'the real first-floor Snipe and second-floor Cruma coordinates must be separated by geodata layers'
    );
    assert.strictEqual(
        GeodataEngine.findPath(23874, 110337, -12096, 23874, 110337, -9056),
        null,
        'the real Cruma multilevel cell must not produce a one-point cross-floor path'
    );
    assert.strictEqual(
        GeodataEngine.hasLineOfSight(264, 127176, -3432, 264, 127176, -3376),
        false,
        'real close layers in region 20_21 must not see through one another'
    );
    const closeLayerPath = GeodataEngine.findPath(264, 127176, -3432, 264, 127176, -3376);
    if (closeLayerPath) {
        assert(closeLayerPath.length > 2, 'close layers may only connect by a real horizontal detour');
        for (let i = 1; i < closeLayerPath.length; i++) {
            const a = closeLayerPath[i - 1], b = closeLayerPath[i];
            assert(GeodataEngine.canWalkStraight(a.locX, a.locY, a.locZ, b.locX, b.locY, b.locZ),
                'each detour segment must follow walkable geodata rather than jump vertically');
        }
    }

} else {
    console.log('SKIP: raw Cruma geodata region 20_21 is not available');
}

const npcTemplate = (locX = 0, locZ = 0) => ({
    selfId: 217,
    kind: 'Monster',
    name: 'Visibility Test Krator',
    title: '',
    level: 44,
    hostile: true,
    str: 40,
    dex: 30,
    con: 40,
    int: 20,
    wit: 20,
    men: 20,
    pAtk: 100,
    pAtkRnd: 0,
    pDef: 100,
    mAtk: 100,
    mDef: 100,
    accur: 4.75,
    atkSpd: 253,
    castSpd: 333,
    atkRadius: 40,
    walk: 60,
    run: 120,
    maxHp: 100,
    maxMp: 100,
    revHp: 1,
    revMp: 1,
    corpseTime: 7,
    radius: 10,
    size: 20,
    weapon: 0,
    shield: 0,
    reuseTime: 0,
    exp: 0,
    sp: 0,
    locX,
    locY: 0,
    locZ,
    head: 0
});
const npc = new Npc(990001, npcTemplate());
let targetX = 20;
const target = {
    fetchId: () => 990002,
    fetchLocX: () => targetX,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    state: { fetchDead: () => false }
};
const session = {
    packets: [],
    dataSendToMe() {},
    dataSendToMeAndOthers(packet) { this.packets.push(packet); }
};

let remoteHits = 0;
npc.attack.remoteHit = () => { remoteHits++; };
GeodataEngine.hasLineOfSight = () => false;
npc.meleeHit(session, npc, target);
npc.castSkill(session, target, {});
assert.strictEqual(session.packets.some((packet) => packet[0] === 0x05), false, 'an NPC must not begin a melee attack without line of sight');
assert.strictEqual(remoteHits, 0, 'an NPC must not begin a skill attack without line of sight');

const expectedRoute = [{ locX: 0, locY: 0, locZ: 0 }, { locX: 16, locY: 0, locZ: 0 }];
GeodataEngine.findPath = () => expectedRoute;
assert.strictEqual(npc.fetchCombatPath(target), expectedRoute, 'NPC combat movement must request a geodata path when direct sight is blocked');

const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalSetInterval = global.setInterval;
const originalDateNow = Date.now;
const originalAbortCombatState = npc.abortCombatState;
let combatTickCallback;
let abortCalls = 0;
let pathCalls = 0;
const timeouts = new Map();
let now = 100000;
function advanceTime(ms) {
    const until = now + ms;
    for (;;) {
        const next = [...timeouts].filter(([, timer]) => timer.at <= until)
            .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, timer] = next;
        timeouts.delete(handle);
        now = timer.at;
        timer.callback();
    }
    now = until;
}
try {
    global.setTimeout = (callback, delay) => {
        const handle = { _idleTimeout: delay };
        timeouts.set(handle, { callback, at: now + delay });
        return handle;
    };
    global.clearTimeout = (handle) => { timeouts.delete(handle); };
    global.setInterval = (callback) => {
        combatTickCallback = callback;
        return {};
    };
    Date.now = () => now;
    npc.abortCombatState = () => { abortCalls++; };
    npc.hasCombatLineOfSight = () => false;
    npc.fetchCombatPathAsync = () => { pathCalls++; return Promise.resolve(null); };
    npc.selectCombatSkill = () => null;

    npc.enterCombatState(session, target);
    advanceTime(Math.min(...[...timeouts.values()].map(timer => timer.at)) - now);
    combatTickCallback();
    combatTickCallback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(abortCalls, 0, 'a single bounded path miss must not immediately clear NPC combat');
    assert.strictEqual(pathCalls, 1, 'path misses must be retried with a backoff instead of every combat tick');

    const cachedRoute = [
        { locX: 0, locY: 0, locZ: 0 },
        { locX: 16, locY: 0, locZ: 0 },
        { locX: 32, locY: 0, locZ: 0 }
    ];
    let cachedPathCalls = 0;
    npc.fetchCombatPathAsync = () => { cachedPathCalls++; return Promise.resolve(cachedRoute); };
    now += 500;
    combatTickCallback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    combatTickCallback();
    const firstMove = npc.automation.moveInterpolation;
    assert(firstMove, 'the first waypoint must start movement');
    advanceTime(firstMove.duration / 2);
    assert(npc.fetchLocX() > 0 && npc.fetchLocX() < 16, 'the NPC must advance toward the first waypoint before arrival');
    advanceTime(firstMove.duration / 2);
    assert.strictEqual(npc.fetchLocX(), 16, 'the NPC must arrive at the first cached waypoint');
    combatTickCallback();

    assert.strictEqual(cachedPathCalls, 1, 'remaining waypoints must be reused without rebuilding the full A* route');
    const secondMove = npc.automation.moveInterpolation;
    assert(secondMove, 'the cached second waypoint must start the next movement leg');
    assert.strictEqual(secondMove.to.locX, 32, 'the next leg must target the second cached waypoint');
    advanceTime(secondMove.duration);
    assert.strictEqual(npc.fetchLocX(), 32, 'the NPC must arrive at the second cached waypoint');
    assert.strictEqual(npc.state.fetchTowards(), false, 'arrival must clear the movement state');
    assert.strictEqual(timeouts.size, 0, 'completed movement must leave no interpolation or arrival callbacks');

    // A target the mob cannot reach (a player running out of sight, a path the pool cannot give):
    // a path that comes back after the target moved on waits for the retry as an empty one does,
    // and the mob keeps hating it past 10 s, until Lisvus's attack timeout (2 min without a hit,
    // a cast or a blow taken) drops the target.
    const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
    let stalePathCalls = 0;
    npc.fetchCombatPathAsync = () => {
        stalePathCalls++;
        targetX = targetX === 20 ? 170 : 20;
        return Promise.resolve(cachedRoute);
    };
    combatTickCallback();
    await settle();
    now += 100;
    combatTickCallback();
    await settle();
    assert.strictEqual(stalePathCalls, 1, 'a path the target outran is retried after a backoff, not on the next tick');
    assert.strictEqual(npc.state.inMotion(), false, 'the mob does not walk a path to where the target was');
    npc.fetchCombatPathAsync = () => { stalePathCalls++; return Promise.resolve(null); };
    const chaseStartedAt = now;
    while (now - chaseStartedAt < 30000) {
        now += 100;
        combatTickCallback();
        await settle();
    }
    assert(stalePathCalls < 15, `an unreachable target is asked for at most every 4 s, not every tick (${stalePathCalls} requests)`);
    assert.strictEqual(abortCalls, 0, 'no way to the target for 30 s does not end the fight');
    assert(npc.aggroList.has(990002), 'the mob keeps hating a target it has no way to');
    now = npc.combatActiveAt + 120000;
    combatTickCallback();
    assert.strictEqual(npc.aggroList.has(990002), false, 'the attack timeout drops the target');
    assert.strictEqual(abortCalls, 1, 'with no one else hated the mob leaves the fight');

    // The chase decides on sight (C4: Lisvus L2Character.doAttack needs the
    // target in sight, a move needs a walk): a mob that sees its target in
    // range acts where it stands, one that does not see it routes to it.
    GeodataEngine.hasLineOfSight = originalHasLineOfSight;
    GeodataEngine.canWalkStraight = originalCanWalkStraight;
    const chaseOn = async (id, mob, body, map) => {
        useMap(map);
        GeodataEngine.hasGeo = () => true;
        const fighter = new Npc(id, npcTemplate(mob.locX, mob.locZ));
        const prey = { fetchId: () => id + 1, fetchLocX: () => body.locX, fetchLocY: () => 0, fetchLocZ: () => body.locZ,
            state: { fetchDead: () => false } };
        const seen = { casts: 0, routes: 0 };
        fighter.attack.remoteHit = () => { seen.casts++; };
        fighter.canUseCombatSkillOn = () => true;
        fighter.fetchCombatPathAsync = () => { seen.routes++; return Promise.resolve(null); };
        fighter.abortCombatState = () => {};
        fighter.selectCombatSkill = () => (mob.castRange ? { fetchDistance: () => mob.castRange } : null);
        fighter.enterCombatState(session, prey);
        advanceTime(Math.min(...[...timeouts.values()].map(timer => timer.at)) - now);
        combatTickCallback();
        await settle();
        advanceTime(200);
        return { fighter, seen };
    };
    try {
        // A body on a raised cell the ground does not open toward (a one-way edge):
        // the mob below cannot walk up to it but sees it, and a ranged mob in range casts.
        const raised = await chaseOn(990011, { locX: 8, locZ: 0, castRange: 600 }, { locX: 168, locZ: 40 },
            (cx) => cx === 10 ? flat(40) : cx === 9 ? flat(0, 14) : flat(0));
        assert.strictEqual(GeodataEngine.canWalkStraight(8, 8, 0, 168, 8, 40), false, 'the mob cannot walk up onto the raised cell');
        assert.strictEqual(raised.seen.casts, 1, 'a ranged mob in range casts at a body it sees but cannot walk to');
        assert.strictEqual(raised.seen.routes, 0, 'it asks for no route to a body it can already hit');
        assert.strictEqual(raised.fighter.fetchLocX(), 8, 'and casts where it stands');
        raised.fighter.destructor(session);

        // A hill crest between them: the mob could walk over it but does not see the body.
        const crest = await chaseOn(990021, { locX: 8, locZ: 0 }, { locX: 328, locZ: 0 },
            (cx) => flat(Math.max(0, Math.min(cx, 20 - cx)) * 40));
        assert.strictEqual(GeodataEngine.canWalkStraight(8, 8, 0, 328, 8, 0), true, 'the crest is walkable');
        assert.strictEqual(crest.seen.routes, 1, 'a mob that does not see its target asks for a route to it');
        assert.strictEqual(crest.fighter.state.inMotion(), false, 'instead of walking straight at a body it cannot see');
        assert.strictEqual(session.packets.some((packet) => packet[0] === 0x05), false, 'and it does not swing blind');
        crest.fighter.destructor(session);

        // A low skirt between them: the mob sees the body over it but cannot walk across it.
        const over = await chaseOn(990031, { locX: 8, locZ: 0 }, { locX: 200, locZ: 0 },
            (cx) => cx === 4 ? flat(0, 14) : cx === 5 || cx === 6 ? flat(24, 4) : flat(0));
        assert.strictEqual(GeodataEngine.hasLineOfSight(8, 8, 0, 200, 8, 0), true, 'the mob sees the body over the skirt');
        assert.strictEqual(GeodataEngine.canWalkStraight(8, 8, 0, 200, 8, 0), false, 'but cannot walk across it');
        assert.strictEqual(over.seen.routes, 1, 'a mob out of range that sees its target but cannot walk straight to it asks for a route');
        assert.strictEqual(over.fighter.state.inMotion(), false, 'instead of walking straight at the skirt it cannot cross');
        over.fighter.destructor(session);
    } finally {
        GeodataEngine.getCellData = originalGetCellData;
        GeodataEngine.readCell = originalReadCell;
        GeodataEngine.hasGeo = originalHasGeo;
    }
} finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalSetInterval;
    Date.now = originalDateNow;
    npc.abortCombatState = originalAbortCombatState;
}

GeodataEngine.hasLineOfSight = originalHasLineOfSight;
GeodataEngine.findPath = originalFindPath;
npc.destructor(session);

console.log('NPC geodata visibility regression checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
