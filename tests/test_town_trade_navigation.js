const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');

const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Corridor = invoke('GameServer/Geodata/TownPathCorridor');
const MoveTo = invoke('GameServer/Actor/Generics/MoveTo');
const Recovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const Automation = invoke('GameServer/Automation');
const World = invoke('GameServer/World/World');
const Towns = invoke('GameServer/Bot/AI/TownPathfinder');

invoke('GameServer/Geodata/VirtualObstacles/index').init();
assert(Geodata.loadRegion(19, 21), 'the observed Gludio routes require real geodata');

let now = Date.now(), serial = 0, searches = 0;
const timers = new Map();
const original = { now: Date.now, setTimeout, clearTimeout, clearInterval, users: World.user };
// Only the movement clock is accelerated. A* and the shared route delivery
// use real map data; no server, world database or player is modified.
const pool = {
    request(r) {
        searches++;
        const path = Geodata.findPath(r.startX, r.startY, r.startZ, r.endX, r.endY, r.endZ, r.maxNodes,
            { debug: false, goalRadius: r.goalRadius, goalZTolerance: r.goalZTolerance });
        if (path) for (let i = 1; i < path.length; i++) {
            assert(Corridor.visible(path[i - 1], path[i]), 'a town route must not cross blocked geometry');
        }
        return Promise.resolve(Corridor.build(path));
    },
    cancel() {}
};

function fixture(id, start) {
    const loc = { ...start };
    const session = { accountId: `bot_trade_route_${id}`, plan: 'hunting',
        pendingFarmDepartureAnnouncement: true, pathfindingWorkerPool: pool, dataSendToMeAndOthers() {} };
    const bot = {
        session, effects: {}, automation: new Automation(),
        state: { towards: false, setTowards(v) { this.towards = v; },
            fetchTowards() { return this.towards; }, inMotion() { return this.towards; }, fetchCasts: () => false },
        fetchId: () => id, fetchClassId: () => 1, fetchLevel: () => 24,
        fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchIsOnline: () => true, isDead: () => false, isBlocked: () => false,
        fetchHead: () => 0, fetchCollectiveRunSpd: () => 140,
        setLocXYZ(point) { Object.assign(loc, point); },
        moveTo(command) { return MoveTo(session, bot, command); }
    };
    session.actor = bot;
    // Keep the entire route visible so the low-detail warp cannot mask a stall.
    World.user = { sessions: [{ accountId: 'route_observer', actor: {
        fetchIsOnline: () => true, fetchLocX: () => loc.locX, fetchLocY: () => loc.locY
    } }] };
    return { bot, session, loc };
}

async function advance(f, tick, arrived, seconds = 90) {
    for (let step = 0; step < seconds * 10; step++) {
        if (arrived()) return;
        if (step % 10 === 0) tick();
        if (f.session.pendingPathRequest) await f.session.pendingPathRequest.promise;
        now += 100;
        for (const [id, timer] of [...timers]) {
            if (timer.at <= now && timers.delete(id)) timer.fn();
        }
    }
    assert(arrived(), `route stalled at ${JSON.stringify({ loc: f.loc, path: f.session.lastPathfinding })}`);
}

async function run() {
    try {
        Date.now = () => now;
        global.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; };
        global.clearTimeout = global.clearInterval = id => timers.delete(id);
        const center = Towns.getTown({ locX: -12736, locY: 122816, locZ: -3114 }).center;
        const street = { locX: -13976, locY: 123512, locZ: -3112 };

        // Cover every identity-based departure offset, including Marksman's
        // original point (-12736,122976), whose only map floor is at -2928.
        assert(Math.abs(Geodata.getHeight(-12736, 122976, -3114) - street.locZ) > 64);
        for (let index = 0; index < 16; index++) {
            const f = fixture(2003056 + index, street);
            assert(Hunting.leaveShop(f.session, f.bot));
            const destination = f.session.lastPathfinding.requestedTo;
            assert(Math.abs(destination.locZ - street.locZ) <= 64,
                'the exit target must remain on the public square floor');
            assert(Corridor.visible(center, destination) && Corridor.visible(destination, center),
                'an identity offset must stay connected to the public square');
            await advance(f, () => Hunting.leaveShop(f.session, f.bot),
                () => Corridor.distance(f.loc, center) <= 900);
            assert.equal(Hunting.leaveShop(f.session, f.bot), false,
                'clearing the shop must release normal hunting decisions');
            assert.equal(f.session.lastPathfinding.lowLodWarp, false);
            f.bot.automation.abortAll(f.bot);
        }

        // The observed f1STm4st3R journey must continue after its first
        // intermediate waypoint rather than mistaking the old goal for motion.
        const shopper = fixture(2003119, center);
        const seller = { locX: -14590, locY: 123360, locZ: -3112, town: 'Gludio' };
        const walkToSeller = () => Recovery.move(shopper.session, shopper.bot, seller, 'shopping',
            { targetActor: null, arrivalRadius: 240 });
        walkToSeller();
        await advance(shopper, walkToSeller, () => Corridor.distance(shopper.loc, seller) <= 240);
        shopper.bot.automation.abortAll(shopper.bot);
        await advance(shopper, () => Hunting.leaveShop(shopper.session, shopper.bot),
            () => Corridor.distance(shopper.loc, center) <= 900);
        shopper.bot.automation.abortAll(shopper.bot);

        // An optional exit must never block the actual farming trip forever,
        // including repeated worker-budget failures rather than an empty path.
        for (const error of [undefined, 'PATH_BUDGET']) {
            const f = fixture(2003060, street);
            let moves = 0;
            f.bot.moveTo = command => { moves++; f.session.lastPathfinding = {
                requestedTo: command.to, routeUsable: false, error, at: now
            }; };
            let released = false;
            for (let attempt = 0; attempt < 15; attempt++) {
                if (!Hunting.leaveShop(f.session, f.bot)) { released = true; break; }
                now += 6000;
            }
            assert(released, 'failed optional shop exit must yield to farm/gatekeeper selection');
            const walked = moves;
            now += 120000;
            assert.equal(Hunting.leaveShop(f.session, f.bot), false,
                'the ended departure keeps farming decisions available, no retry');
            assert.equal(moves, walked, 'nor walks for the exit again');
        }
        console.log(`Gludio shop, merchant and departure recovery checks passed: 16 exit variants, ${searches} searches`);
    } finally {
        Date.now = original.now;
        global.setTimeout = original.setTimeout;
        global.clearTimeout = original.clearTimeout;
        global.clearInterval = original.clearInterval;
        World.user = original.users;
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
