const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

(async () => {

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');

const originalGetCellData = GeodataEngine.getCellData;
const originalHasGeo = GeodataEngine.hasGeo;
const originalHasLineOfSight = GeodataEngine.hasLineOfSight;
const originalFindPath = GeodataEngine.findPath;

GeodataEngine.hasGeo = () => true;
GeodataEngine.getCellData = (_x, _y, z) => ({
    z: z < -10000 ? -12096 : -9056,
    nswe: 15
});

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

GeodataEngine.getCellData = (_x, _y, z) => ({ z: z < 32 ? 0 : 64, nswe: 15 });
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

GeodataEngine.getCellData = (x, _y, z) => {
    const cx = x >> 4;
    if (cx === 0) return { z, nswe: 14 }; // East is blocked.
    if (cx === 1) return { z, nswe: 13 }; // West is blocked.
    return { z, nswe: 15 };
};
assert.strictEqual(
    GeodataEngine.hasLineOfSight(8, 8, 0, 24, 8, 0),
    false,
    'NSWE walls must block line of sight between adjacent cells'
);

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
GeodataEngine.hasLineOfSight = (fromX, fromY, fromZ, toX, toY, toZ) => (
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
GeodataEngine.hasGeo = originalHasGeo;
GeodataEngine.hasLineOfSight = originalHasLineOfSight;

const crumaRegion = path.join(GeodataEngine.getGeodataDir(), '20_21.l2j');
if (fs.existsSync(crumaRegion)) {
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
    assert.strictEqual(
        GeodataEngine.findPath(264, 127176, -3432, 264, 127176, -3376),
        null,
        'real close layers in region 20_21 must not produce a one-point vertical path'
    );
} else {
    console.log('SKIP: raw Cruma geodata region 20_21 is not available');
}

const npc = new Npc(990001, {
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
    locX: 0,
    locY: 0,
    locZ: 0,
    head: 0
});
const target = {
    fetchId: () => 990002,
    fetchLocX: () => 20,
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
const originalSetInterval = global.setInterval;
const originalDateNow = Date.now;
const originalAbortCombatState = npc.abortCombatState;
let combatTickCallback;
let abortCalls = 0;
let pathCalls = 0;
const timeoutCallbacks = [];
let now = 100000;
try {
    global.setTimeout = (callback) => {
        timeoutCallbacks.push(callback);
        return {};
    };
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
    timeoutCallbacks.shift()();
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
    timeoutCallbacks.shift()();
    combatTickCallback();

    assert.strictEqual(cachedPathCalls, 1, 'remaining waypoints must be reused without rebuilding the full A* route');
    assert.strictEqual(timeoutCallbacks.length, 1, 'the cached second waypoint must schedule the next movement leg');
} finally {
    global.setTimeout = originalSetTimeout;
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
