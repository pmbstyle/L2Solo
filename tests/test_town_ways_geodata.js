const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./helpers/databaseIsolation');
require('../src/Global');

// The town ways on the real map. (c) Every leg a body takes on a committed way
// (from each way point, spawn point, town NPC and spur point, as the reader picks
// it) is found by the smallest search a walk issues (2000 nodes, exact goal).
// (a) The scroll-less errand walk from Karul Bugbear fields (20_12) and from the
// next spot (20_13) to Hally in Hunter's Village, as ShoppingState walks it (CompanionNavigationRecovery, MoveTo,
// the worker pool's search), reaches Hally; the straight leg found no way there.
// (b) The walk back from Hally and from Garette to 20_12, as HuntingState starts
// and drives it (sync 2000-node moves on main), reaches the spot's centre.
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const TownWays = invoke('GameServer/Bot/Travel/TownWays');
const FIXTURE = path.join(__dirname, 'fixtures', 'town-ways-karul.json');

invoke('GameServer/Geodata/VirtualObstacles/index').init();
assert(Geodata.loadRegion(23, 20), 'the Karul Bugbear walks require real geodata');

const flat = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
const legWalks = (a, b) => {
    if (a.locX >> 4 === b.locX >> 4 && a.locY >> 4 === b.locY >> 4 && a.locZ === b.locZ) return true;
    const found = Geodata.findPath(a.locX, a.locY, a.locZ, b.locX, b.locY, b.locZ, 2000, { debug: false });
    return Array.isArray(found) && found.length > 1;
};
const onFloor = (p) => ({ locX: p.locX, locY: p.locY, locZ: Geodata.getHeight(p.locX, p.locY, p.locZ) });

// ------------------------------------------------------------ (c) drift guard
function driftGuard(file, catalogue) {
    const table = JSON.parse(fs.readFileSync(file, 'utf8'));
    TownWays.useFile(file);
    const TownRespawn = invoke('GameServer/World/TownRespawn');
    const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
    const failed = [];
    let legs = 0;
    const check = (spotId, what, from, target) => {
        if (!target) return;
        legs++;
        if (!legWalks(from, target)) failed.push(`${spotId} ${what} ${from.locX},${from.locY},${from.locZ}`);
    };
    let spawnFails = 0, intoFails = 0;
    const byTown = new Map();
    const walks = (points, from = points[0]) => {
        const target = TownWays.next(points, from);
        legs++;
        return !target || legWalks(from, target);
    };
    for (const spotId of Object.keys(table.ways)) {
        const way = TownWays.way(spotId);
        byTown.set(way.townKey, [...(byTown.get(way.townKey) || []), way]);
        way.out.forEach((p) => check(spotId, 'out', p, TownWays.next(way.out, p)));
        way.back.forEach((p) => check(spotId, 'back', p, TownWays.next(way.back, p)));
        way.spurs.forEach((spur) => spur.forEach((p) => check(spotId, 'spawn spur', p, TownWays.wayPoint(way, p, true))));
        // The walk in to each town NPC: the way out on along its spur.
        way.into.forEach((into) => { if (into && !into.every((p) => walks(into, p))) intoFails++; });
        // The first leg out from each spawn point of the spot.
        const spot = catalogue.get(spotId);
        assert(spot, `the table's spot ${spotId} is a spot of the catalogue`);
        for (const point of spot.arrivalPoints || []) {
            const from = onFloor(point), target = TownWays.wayPoint(way, from, true);
            if (!target || !legWalks(from, target)) spawnFails++;
        }
    }
    // The walk back from each service NPC: from the NPC along its spur and on to each way back.
    let npcFails = 0;
    for (const [townKey, townWays] of byTown) {
        for (const npc of TownServiceCatalog.rows().filter((row) => row.town === TownRespawn.towns[townKey].name)) {
            const at = townWays[0].npcs.findIndex((p) => p.locX === npc.locX && p.locY === npc.locY);
            const spur = at < 0 ? [] : townWays[0].townSpurs[at];
            // A way with no way back gives the walk back no leg (the reader's rule, the build's filter).
            if (townWays.filter((way) => way.back.length).some((way) => spur.some((p) => {
                const target = TownWays.wayPoint(way, p, false, true);
                legs++;
                return !target || !legWalks(p, target);
            }))) npcFails++;
        }
    }
    const counts = table.header.counts;
    assert.deepStrictEqual(failed, [], `${file}: every leg of every way passes a 2000-node search (${legs} legs)`);
    assert(spawnFails <= counts.spawnJoinUnfixed, `${file}: ${spawnFails} spawn points fail their first leg out, the build left ${counts.spawnJoinUnfixed}`);
    assert(npcFails <= counts.npcBackUnfixed, `${file}: ${npcFails} town NPCs fail a leg of their walk back, the build left ${counts.npcBackUnfixed}`);
    assert(intoFails <= counts.npcIntoFail, `${file}: ${intoFails} walks in to a town NPC fail a leg, the build left ${counts.npcIntoFail}`);
    return legs;
}

// ------------------------------------------------------------ walk harness
const MoveTo = invoke('GameServer/Actor/Generics/MoveTo');
const Recovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const Automation = invoke('GameServer/Automation');
const World = invoke('GameServer/World/World');
let now = Date.now(), serial = 0, searches = 0;
const timers = new Map();
const original = { now: Date.now, setTimeout, clearTimeout, clearInterval, users: World.user };
// The worker pool's search, run in place: the real map, the request's budget and goal.
const pool = {
    request(r) {
        searches++;
        return Promise.resolve(Geodata.findPath(r.startX, r.startY, r.startZ, r.endX, r.endY, r.endZ, r.maxNodes,
            { debug: false, goalRadius: r.goalRadius, goalZTolerance: r.goalZTolerance }));
    },
    cancel() {}
};

function body(id, start, extra = {}) {
    const loc = { ...start };
    const session = { accountId: `bot_town_way_${id}`, plan: 'hunting', pathfindingWorkerPool: pool, dataSendToMeAndOthers() {}, ...extra };
    const bot = {
        session, effects: {}, automation: new Automation(),
        state: { towards: false, setTowards(v) { this.towards = v; }, fetchTowards() { return this.towards; },
            inMotion() { return this.towards; }, fetchCasts: () => false, fetchHits: () => false, fetchDead: () => false,
            fetchSeated: () => false, setCasts() {} },
        fetchId: () => id, fetchClassId: () => 1, fetchLevel: () => 36, fetchKarma: () => 0,
        fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchIsOnline: () => true, isDead: () => false, isBlocked: () => false,
        fetchHead: () => 0, fetchCollectiveRunSpd: () => 140, unselect() {},
        setLocXYZ(point) { Object.assign(loc, point); },
        moveTo(command) { return MoveTo(session, bot, command); }
    };
    session.actor = bot;
    // A player watches the whole walk: the unseen-walk warp cannot hide a stall.
    World.user = { sessions: [{ accountId: 'route_observer', actor: {
        fetchIsOnline: () => true, fetchLocX: () => loc.locX, fetchLocY: () => loc.locY
    } }] };
    return { bot, session, loc };
}

async function advance(f, tick, arrived, seconds) {
    for (let step = 0; step < seconds * 10; step++) {
        if (arrived()) return;
        if (step % 10 === 0) tick();
        if (f.session.pendingPathRequest) await f.session.pendingPathRequest.promise;
        now += 100;
        for (const [id, timer] of [...timers]) {
            if (timer.at <= now && timers.delete(id)) timer.fn();
        }
    }
    assert(arrived(), `walk stalled at ${JSON.stringify({ loc: f.loc, path: f.session.lastPathfinding })}`);
}

const CENTER = { locX: 123948, locY: 75896, locZ: -2605 };
const CENTER_13 = { locX: 124307, locY: 81156, locZ: -2474 };
const HALLY = { locX: 116646, locY: 74820, locZ: -2581, town: "Hunter's Village" };
const GARETTE = { locX: 116109, locY: 75022, locZ: -2583 };

// (a) bless1ng's position on 20_12 (run B), no scroll: the errand walk to Hally.
async function errandWalk(id, start, spot = { id: '20_12', center: CENTER }) {
    const f = body(id, start, { currentSpot: { id: spot.id, center: { ...spot.center } } });
    const target = { ...HALLY };
    let worst = 0;
    const walk = () => {
        const navigation = Recovery.move(f.session, f.bot, target, 'shopping', { targetActor: null, arrivalRadius: 240 });
        worst = Math.max(worst, navigation.failures || 0);
        assert.notEqual(navigation.status, 'exhausted', `the errand walk gave up at ${JSON.stringify(f.loc)}`);
    };
    walk();
    await advance(f, walk, () => flat(f.loc, HALLY) <= 240, 600);
    assert.equal(worst, 0, 'no leg of the way failed');
    f.bot.automation.abortAll(f.bot);
}

// (b) The walk back to the spot the worker's choice names, started by HuntingState
// (beginSpotRelocation) and driven by its tick; the spot's arrival is narrowed to
// 250 u of its centre so the walk is followed to the end of the way.
async function walkBack(id, start) {
    const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
    const Spots = invoke('GameServer/Bot/AI/SpotService');
    const spot = { id: '20_12', name: 'Karul Bugbear fields', center: { ...CENTER },
        minLevel: 35, maxLevel: 37, avgLevel: 36, density: 30, levelCounts: { 36: 30 }, npcNames: [] };
    Spots.findCurrentSpot = () => null;
    Spots.ensureIndexed = () => [spot];
    Spots.arrivedAt = (target, loc) => flat(target.center, loc) <= 250;
    const f = body(id, start, { noTargetTicks: 5, decisionStats: { huntSpot: { spotId: spot.id } },
        heldEconomy: { network: { activity: { activity: 'hunting', spotId: spot.id } },
            stock: () => ({ itemId: 0, usePerHour: 0 }), statsPacket: {} } });
    f.session.botStatus = { available: true, mode: 'hunting', level: 36, loc: start, blockers: ['no_targets_nearby'],
        nearby: { attackableNpcs: 0, eligibleAttackableNpcs: 0 } };
    const ai = { say() {}, getStatus: (s) => s.botStatus };
    const methods = [];
    const tick = () => {
        Hunting.tick(f.session, f.bot, {}, ai);
        const last = f.session.lastSpotRelocation?.method;
        if (last && methods[methods.length - 1] !== last) methods.push(last);
    };
    await advance(f, tick, () => f.session.lastSpotRelocation?.method === 'walk', 900);
    assert(!methods.includes('walk_route_unavailable'), `no leg of the walk back failed (${methods.join(', ')})`);
    assert(flat(f.loc, CENTER) <= 250, `the walk back ends at the spot's centre, not ${JSON.stringify(f.loc)}`);
    f.bot.automation.abortAll(f.bot);
}

async function run() {
    const started = Date.now();
    // The catalogue's spawn points (the spot generator's catalogue, as the build reads it).
    const catalogue = new Map(require('../scripts/generate-spot-table').buildCatalogue().profiles.map((spot) => [spot.id, spot]));
    let legs = driftGuard(FIXTURE, catalogue);
    if (fs.existsSync(TownWays.DEFAULT_FILE)) legs += driftGuard(TownWays.DEFAULT_FILE, catalogue);
    const guardSeconds = Math.round((Date.now() - started) / 1000);
    TownWays.useFile(FIXTURE);

    // The near body holds a decision without wishes (DecisionEvents.held): no economy datapack here.
    invoke('GameServer/Bot/AI/DecisionEvents').held = (session) => session.heldEconomy;
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    invoke('GameServer/Bot/AI/HotTownRebuff').syncVisit = () => null;
    invoke('GameServer/Bot/AI/HotTownRebuff').needsVisit = () => false;
    invoke('GameServer/Bot/AI/BotBuffs').needsNewbieRefresh = () => false;
    invoke('GameServer/Inventory/ShotStock').needsActorRestock = () => false;
    invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor = () => null;
    invoke('GameServer/Bot/AI/TownChatter').say = () => {};
    try {
        Date.now = () => now;
        global.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; };
        global.clearTimeout = global.clearInterval = (id) => timers.delete(id);
        // Each walk on its own body and clock queue: one walk's failure does not hide another's.
        const failures = [];
        for (const [name, walk] of [['errand walk from the field to Hally', () => errandWalk(2001505, { locX: 123700, locY: 75953, locZ: -2464 })],
            ['errand walk from 20_13 to Hally', () => errandWalk(2001508, onFloor({ locX: 123340, locY: 79482, locZ: -2229 }), { id: '20_13', center: CENTER_13 })],
            ['walk back from Hally', () => walkBack(2001506, onFloor(HALLY))],
            ['walk back from Garette', () => walkBack(2001507, onFloor(GARETTE))]]) {
            timers.clear();
            try { await walk(); } catch (error) { failures.push(`${name}: ${error.message.split('\n')[0]}`); }
        }
        assert.deepStrictEqual(failures, []);
    } finally {
        Date.now = original.now;
        global.setTimeout = original.setTimeout;
        global.clearTimeout = original.clearTimeout;
        global.clearInterval = original.clearInterval;
        World.user = original.users;
        TownWays.useFile();
    }
    console.log(`Town ways geodata checks passed: ${legs} way legs in ${guardSeconds} s, errand walk and walks back, ${searches} searches`);
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
