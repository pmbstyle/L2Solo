const assert = require('node:assert');
require('../src/Global');

const World = invoke('GameServer/World/World');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Movement = invoke('GameServer/Bot/AI/PartySupportMovement');
const MoveTo = invoke('GameServer/Actor/Generics/MoveTo');
const Automation = invoke('GameServer/Automation');
const NpcAggro = invoke('GameServer/Npc/NpcAggro');

function actor(id, position) {
    return {
        fetchId: () => id, fetchName: () => `Member${id}`, fetchIsOnline: () => true,
        fetchLocX: () => position.locX, fetchLocY: () => position.locY, fetchLocZ: () => position.locZ,
        fetchHead: () => 0, fetchCollectiveRunSpd: () => 120,
        isDead: () => false, isBlocked: () => false,
        setLocXYZ(next) { Object.assign(position, next); },
        state: { towards: false, fetchTowards() { return this.towards; }, setTowards(value) { this.towards = value; } }
    };
}

function hostile(x, y, z = 0) {
    return { ...actor(19001, { locX: x, locY: y, locZ: z }), fetchHostile: () => true };
}

function fixture() {
    const position = { locX: 0, locY: 0, locZ: 0 };
    const leaderPosition = { ...position };
    const leader = { accountId: 'player_support_route', actor: actor(7001, leaderPosition) };
    const bot = actor(7002, position);
    const packets = [];
    const session = { accountId: 'bot_support_route', actor: bot, partyCompanion: true,
        followPlayerSession: leader, plan: 'following', dataSendToMeAndOthers(packet) { packets.push(packet); } };
    bot.session = session;
    bot.automation = new Automation();
    World.user = { sessions: [leader, session] };
    return { session, bot, position, leaderPosition, packets };
}

const originals = {
    world: World.user, fetchNpcs: World.fetchNpcsInRadius,
    findPath: Geodata.findPath, los: Geodata.hasLineOfSight, walk: Geodata.canWalkStraight, height: Geodata.getHeight,
    now: Date.now, timeout: global.setTimeout, clearTimeout: global.clearTimeout, clearInterval: global.clearInterval
};
let hazards = [];
let clock = 100000;
const timers = new Map();
global.setTimeout = (callback, duration) => {
    const handle = {};
    timers.set(handle, { callback, at: clock + duration });
    return handle;
};
global.clearTimeout = global.clearInterval = handle => timers.delete(handle);
Date.now = () => clock;
World.fetchNpcsInRadius = () => hazards;
Geodata.hasLineOfSight = () => true;
Geodata.canWalkStraight = () => true;
Geodata.getHeight = (_x, _y, z) => z;
Geodata.findPath = () => { throw new Error('support routes must keep pathfinding off the game thread'); };

function advanceTimers() {
    const [handle, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(handle);
    clock = timer.at;
    timer.callback();
}

async function nativeRoute(member, path, beforeReply = () => {}) {
    const to = { ...path.at(-1) };
    let reply;
    member.session.pathfindingWorkerPool = { request: () => new Promise(resolve => { reply = resolve; }), cancel() {} };
    MoveTo(member.session, member.bot, { from: { ...member.position }, to,
        routeGuard: Movement.routeGuard(member.session, member.bot, to) });
    const completion = member.session.pendingPathRequest.promise;
    beforeReply();
    reply(path);
    await completion;
}

(async () => {
    const formation = { locX: -330, locY: 0, locZ: 0 };
    let member = fixture();
    hazards = [hostile(-700, 0)];
    assert(Movement.followDestination(member.session, member.bot, formation).locX > -200,
        'formation must contract toward the leader instead of entering an idle hostile aggro circle');
    hazards = [hostile(-700, 0, 1000)];
    assert.deepStrictEqual(Movement.followDestination(member.session, member.bot, formation), formation,
        'a hostile on another floor must not prevent a safe formation move');
    hazards = [{ ...hostile(-700, 0), fetchDestId: () => 7001, state: { fetchCombats: () => true } }];
    assert.deepStrictEqual(Movement.followDestination(member.session, member.bot, formation), formation,
        'a mob already engaged by the party is not a new proximity pull');
    hazards = [{ ...hostile(-700, 0), fetchDestId: () => 7001, aggroEligibleAt: clock + 10000 }];
    assert(Movement.followDestination(member.session, member.bot, formation).locX > -200,
        'spawn grace and a stale target id cannot make an idle hostile route safe');

    hazards = [hostile(-400, 0), hostile(700, 0)];
    member.position.locX = 200;
    assert.strictEqual(Movement.followDestination(member.session, member.bot, formation), null,
        'if all regroup routes enter another hostile radius, hold rather than create another add');

    hazards = [];
    member = fixture();
    const target = actor(7003, { locX: 800, locY: 0, locZ: 0 });
    const castGoal = Movement.supportDestination(member.session, member.bot, target, 600);
    assert(castGoal.locX >= 200 && castGoal.locX <= 450,
        'healing approach must end within casting range while remaining near the leader');
    assert.strictEqual(Movement.supportDestination(member.session, member.bot,
        actor(7003, { locX: 1600, locY: 0, locZ: 0 }), 600), null,
    'a remote patient cannot lure the provider outside the party circle');

    // A dangerous straight line must not suppress a safe native geodata detour.
    member = fixture();
    member.position.locX = 1200;
    hazards = [hostile(600, 0)];
    assert.deepStrictEqual(Movement.followDestination(member.session, member.bot, formation), formation,
        'an intervening hostile must not reject a safe endpoint before the worker can find an alternate path');
    await nativeRoute(member, [{ ...member.position }, { locX: 1000, locY: 650, locZ: 0 },
        { locX: 0, locY: 650, locZ: 0 }, formation]);
    assert.strictEqual(member.session.lastPathfinding.routeUsable, true);
    assert.strictEqual(member.bot.state.fetchTowards(), 'move', 'the safe worker detour must actually begin');
    member.bot.automation.abortAll(member.bot);

    // Walking along a wall is safe when the mob cannot see into the corridor.
    member = fixture();
    member.position.locX = 300;
    hazards = [hostile(100, 200)];
    Geodata.hasLineOfSight = (_fromX, fromY, _fromZ, _toX, toY) => fromY === 0 && toY === 0;
    assert.strictEqual(NpcAggro.canEngage(hazards[0], member.bot), false);
    assert.deepStrictEqual(Movement.followDestination(member.session, member.bot, formation), formation,
        'a mob behind an opaque wall must not block an otherwise safe formation goal');
    await nativeRoute(member, [{ ...member.position }, formation]);
    assert.strictEqual(member.session.lastPathfinding.routeUsable, true);
    assert.strictEqual(member.bot.state.fetchTowards(), 'move', 'a safe corridor route must actually begin');
    member.bot.automation.abortAll(member.bot);

    member = fixture();
    member.position.locX = 100;
    hazards = [hostile(0, 200)];
    Geodata.hasLineOfSight = (_fromX, fromY, _fromZ, toX) => fromY === 0 || toX <= -200;
    assert.strictEqual(NpcAggro.canEngage(hazards[0], member.bot), false);
    assert.strictEqual(NpcAggro.canEngage(hazards[0], actor(7003, formation)), true);
    assert.notDeepStrictEqual(Movement.followDestination(member.session, member.bot, formation), formation,
        'being hidden inside the XY radius must not permit a visible endpoint even if it is farther from the mob');

    // Visibility can open mid-route even if the nearest point remains hidden.
    member = fixture();
    member.position.locX = 400;
    hazards = [hostile(0, 200)];
    Geodata.hasLineOfSight = (_fromX, fromY, _fromZ, toX, toY) => fromY === 0 ||
        (toY === 0 && toX >= 64 && toX <= 96);
    assert.strictEqual(NpcAggro.canEngage(hazards[0], member.bot), false);
    assert.strictEqual(NpcAggro.canEngage(hazards[0], actor(7003, { locX: 80, locY: 0, locZ: 0 })), true);
    assert.deepStrictEqual(Movement.followDestination(member.session, member.bot, formation), formation);
    await nativeRoute(member, [{ ...member.position }, formation]);
    assert.strictEqual(member.session.lastPathfinding.movementRejected, true,
        'a visible opening inside aggro range must reject the route even when its endpoints and nearest point are hidden');
    assert.strictEqual(member.packets.length, 0);

    member = fixture();
    Object.assign(member.position, { locX: 400, locY: 100 });
    Geodata.hasLineOfSight = (_fromX, fromY, _fromZ, toX, toY) => fromY !== 200 ||
        (Math.floor(toX / 16) === 8 && Math.floor(toY / 16) === 4);
    assert.strictEqual(NpcAggro.canEngage(hazards[0], member.bot), false);
    assert.strictEqual(NpcAggro.canEngage(hazards[0], actor(7003, { locX: 140, locY: 64.4, locZ: 0 })), true);
    await nativeRoute(member, [{ ...member.position }, formation]);
    assert.strictEqual(member.session.lastPathfinding.movementRejected, true,
        'diagonal movement must check briefly crossed visible cells, not only uniformly spaced samples');
    assert.strictEqual(member.packets.length, 0);
    Geodata.hasLineOfSight = () => true;

    // Native worker paths can detour into aggro even when both endpoints are safe.
    member = fixture();
    hazards = [hostile(0, 850)];
    await nativeRoute(member, [{ ...member.position }, { locX: 0, locY: 400, locZ: 0 }, formation]);
    assert.strictEqual(member.session.lastPathfinding.movementRejected, true);
    assert.strictEqual(member.session.activeMoveGoal, null);
    assert.strictEqual(member.bot.state.fetchTowards(), false);
    assert.strictEqual(member.packets.length, 0, 'a rejected worker detour must not announce or start movement');
    assert.deepStrictEqual(member.position, { locX: 0, locY: 0, locZ: 0 });
    assert.notDeepStrictEqual(Movement.followDestination(member.session, member.bot, formation), formation,
        'a rejected native route must make the next tick try a nearer formation goal');

    hazards = [];
    member = fixture();
    await nativeRoute(member, [{ ...member.position }, formation], () => { member.leaderPosition.locX = 1000; });
    assert.strictEqual(member.session.lastPathfinding.movementRejected, true,
        'a worker reply must validate against the current leader position');
    assert.strictEqual(member.packets.length, 0);

    member = fixture();
    hazards = [hostile(600, 0)];
    const shortGoal = { locX: 100, locY: 0, locZ: 0 };
    MoveTo(member.session, member.bot, { from: { ...member.position }, to: shortGoal,
        routeGuard: Movement.routeGuard(member.session, member.bot, shortGoal) });
    assert.strictEqual(member.session.lastPathfinding.strategy, 'short_direct');
    assert.strictEqual(member.session.lastPathfinding.movementRejected, true,
        'short direct routes must apply the same aggro guard as worker paths');
    assert.strictEqual(member.packets.length, 0);

    hazards = [];
    member = fixture();
    await nativeRoute(member, [{ ...member.position }, { locX: 0, locY: 40, locZ: 0 }, formation]);
    assert.strictEqual(member.bot.state.fetchTowards(), 'move', 'a safe worker route must start normally');
    hazards = [hostile(-700, 0)];
    for (let tick = 0; timers.size && tick < 10; tick++) advanceTimers();
    assert.strictEqual(member.session.lastPathfinding.movementRejected, true,
        'a newly spawned hostile must stop the next native leg before the support enters its aggro radius');
    assert.deepStrictEqual(member.position, { locX: 0, locY: 40, locZ: 0 });
    assert.strictEqual(member.packets.length, 1, 'only the safe first leg may be announced');
    assert.strictEqual(member.bot.state.fetchTowards(), false);
    console.log('Party support formation, cast range, leash and native worker route regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    World.user = originals.world;
    World.fetchNpcsInRadius = originals.fetchNpcs;
    Geodata.findPath = originals.findPath;
    Geodata.hasLineOfSight = originals.los;
    Geodata.canWalkStraight = originals.walk;
    Geodata.getHeight = originals.height;
    Date.now = originals.now;
    global.setTimeout = originals.timeout;
    global.clearTimeout = originals.clearTimeout;
    global.clearInterval = originals.clearInterval;
});
