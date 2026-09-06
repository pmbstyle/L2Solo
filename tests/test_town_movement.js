const assert = require('assert');
require('../src/Global');
const moveTo = invoke('GameServer/Actor/Generics/MoveTo');
const Automation = invoke('GameServer/Automation');
const World = invoke('GameServer/World/World');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Corridor = invoke('GameServer/Geodata/TownPathCorridor');
const Navigation = invoke('GameServer/Bot/AI/TownNavigation');
const Traffic = invoke('GameServer/Bot/AI/TownTraffic');

async function run(count) {
    invoke('GameServer/Geodata/VirtualObstacles/index').init();
    assert(Geodata.loadRegion(20, 22));
    const start = { locX: 18769, locY: 145629, locZ: -3108 };
    const target = { locX: 19099, locY: 143987, locZ: -3071, town: 'Dion' };
    let queries = 0;
    const pool = { request(r) {
        queries++;
        const path = Geodata.findPath(r.startX, r.startY, r.startZ, r.endX, r.endY, r.endZ, r.maxNodes,
            { debug: false, goalRadius: r.goalRadius, goalZTolerance: r.goalZTolerance });
        return Promise.resolve(Corridor.build(path));
    }, cancel() {} };
    const player = { accountId: 'movement_test_player', actor: {
        fetchIsOnline: () => true, fetchLocX: () => start.locX, fetchLocY: () => start.locY, fetchLocZ: () => start.locZ
    } };
    const originalWorld = World.user;
    const originalNow = Date.now, originalTimeout = global.setTimeout, originalClear = global.clearTimeout,
        originalClearInterval = global.clearInterval;
    let now = Date.now(), serial = 1, packets = 0, stops = 0;
    const timers = new Map();
    const bots = Array.from({ length: count }, (_, index) => {
        const loc = { ...start };
        const session = { accountId: `bot_movement_${index}`, pathfindingWorkerPool: pool, dataSendToMeAndOthers(packet) {
            packets++;
            if (packet[0] === 0x47) stops++;
        } };
        const actor = { session, state: { towards: false, inMotion() { return this.towards; }, fetchTowards() { return this.towards; }, setTowards(v) { this.towards = v; } },
            effects: {}, automation: new Automation(), fetchId: () => 23000 + index, isDead: () => false, isBlocked: () => false,
            fetchIsOnline: () => true, fetchHead: () => 0, fetchCollectiveRunSpd: () => 120,
            fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ,
            setLocXYZ(p) { Object.assign(loc, p); } };
        session.actor = actor;
        return { session, actor, loc };
    });
    try {
        Date.now = () => now;
        global.setTimeout = (fn, ms) => { const id = serial++; timers.set(id, { fn, at: now + ms }); return id; };
        global.clearTimeout = global.clearInterval = (id) => timers.delete(id);
        World.user = { sessions: [player, ...bots.map((b) => b.session)] };
        for (const b of bots) moveTo(b.session, b.actor, { from: { ...start }, to: { ...target }, pathMaxNodes: 30000, arrivalRadius: 32 });
        await Promise.all(bots.map((b) => b.session.pendingPathRequest?.promise));
        assert.strictEqual(queries, 1, 'the actual movement entry point must share the expensive town request');
        assert(bots.every((b) => b.session.lastPathfinding.townNavigation), 'applied paths must expose navigation diagnostics');
        // Exercise cancellation after movement has started, then invoke its
        // stale callback explicitly to model a callback already dispatched.
        const cancelled = bots[0];
        const oldCallback = timers.get(cancelled.session.moveTimer).fn;
        cancelled.actor.automation.abortAll(cancelled.actor);
        const stoppedAt = { ...cancelled.loc };
        const pending = bots.slice(1);
        for (let step = 0; step < 1600 && timers.size; step++) {
            now += 50;
            const due = [...timers.entries()].filter(([, t]) => t.at <= now);
            for (const [id, timer] of due) {
                if (!timers.delete(id)) continue;
                timer.fn();
            }
        }
        oldCallback();
        assert.deepStrictEqual(cancelled.loc, stoppedAt, 'an obsolete movement callback must not resurrect cancelled movement');
        assert(pending.every((b) => !b.session.moveTimer), 'local avoidance must not strand actors in a retry loop');
        assert(pending.every((b) => Corridor.distance(b.loc, target) <= 32), 'all active bots must reach the requested area');
        assert(packets > count, 'movement must emit real protocol segments');
        assert(stops >= 1, 'cancellation must stop the client animation');
        assert(Traffic.stats().maxCandidates <= Traffic.MAX_CANDIDATES);
        assert.strictEqual(Navigation.forPool(pool).stats().consumers, 0);
        assert.strictEqual(Traffic.stats().actors, 0, 'completed/cancelled town movement must release occupancy');
        console.log(`Town movement executor checks passed: ${count} bots, ${packets} packets, ${stops} stops, ${queries} search`);
    } finally {
        Date.now = originalNow;
        global.setTimeout = originalTimeout;
        global.clearTimeout = originalClear;
        global.clearInterval = originalClearInterval;
        World.user = originalWorld;
    }
}
(async () => {
    for (const count of [25, 100, 250]) await run(count);
})().catch((error) => { console.error(error); process.exitCode = 1; });
