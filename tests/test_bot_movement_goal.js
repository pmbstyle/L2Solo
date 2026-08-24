const assert = require('assert');

require('../src/Global');

const Automation = invoke('GameServer/Automation');
const moveTo = invoke('GameServer/Actor/Generics/MoveTo');
const RuntimeWorld = invoke('GameServer/World/World');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

class BotSession {}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
    const originalWorldUser = RuntimeWorld.user;
    const originalFindPath = GeodataEngine.findPath;
    const originalHasLineOfSight = GeodataEngine.hasLineOfSight;
    const originalGetHeight = GeodataEngine.getHeight;
    const packets = [];
    const position = { locX: 100, locY: 200, locZ: -300 };
    let runSpeed = 100000;
    let findPathCalls = 0;

    const session = new BotSession();
    Object.assign(session, {
        accountId: 'bot_movement_goal_test',
        dataSendToMeAndOthers(packet, actor) { packets.push({ packet, actor }); }
    });
    const state = {
        towards: false,
        inMotion() { return !!this.towards; },
        fetchTowards() { return this.towards; },
        setTowards(value) { this.towards = value; }
    };
    const actor = {
        session,
        state,
        effects: {},
        isDead: () => false,
        isBlocked: () => false,
        fetchId: () => 4201,
        fetchName: () => 'MovementGoalBot',
        fetchIsOnline: () => true,
        fetchLocX: () => position.locX,
        fetchLocY: () => position.locY,
        fetchLocZ: () => position.locZ,
        fetchHead: () => 0,
        fetchCollectiveRunSpd: () => runSpeed,
        setLocXYZ(next) { Object.assign(position, next); }
    };
    actor.automation = new Automation();
    session.actor = actor;

    const playerSession = {
        accountId: 'player_movement_goal_test',
        actor: {
            fetchIsOnline: () => true,
            fetchLocX: () => 100,
            fetchLocY: () => 200
        }
    };
    RuntimeWorld.user = { sessions: [session, playerSession] };

    GeodataEngine.findPath = (startX, startY, startZ, endX, endY, endZ) => {
        findPathCalls++;
        return [
            { locX: 104, locY: 200, locZ: startZ },
            { locX: endX, locY: endY, locZ: endZ }
        ];
    };
    GeodataEngine.hasLineOfSight = () => true;
    GeodataEngine.getHeight = (x, y, z) => z;

    try {
        const destination = { locX: 1100, locY: 200, locZ: -300 };
        const first = moveTo(session, actor, {
            from: { ...position },
            to: { ...destination }
        });
        const firstTimer = session.moveTimer;
        const firstGeneration = session.moveRouteGeneration;

        assert.strictEqual(findPathCalls, 1, 'the initial movement goal should calculate one route');
        assert.strictEqual(packets.length, 1, 'the near-start geodata node must not emit a micro-movement packet');
        assert(session.activeMoveGoal, 'a running route should retain its semantic destination');

        const reused = moveTo(session, actor, {
            from: { ...position },
            to: { ...destination }
        });
        assert.strictEqual(reused, first, 'the same active destination should reuse existing diagnostics');
        assert.strictEqual(findPathCalls, 1, 'the same active destination must not rerun A*');
        assert.strictEqual(packets.length, 1, 'the same active destination must not broadcast StopMove or MoveToLocation');
        assert.strictEqual(session.moveTimer, firstTimer, 'the same active destination must retain its interpolator');
        assert.strictEqual(session.moveRouteGeneration, firstGeneration, 'the same active destination must not invalidate its route generation');

        session.activeMoveGoal.lastProgressSampleAt = Date.now() - 1000;
        session.activeMoveGoal.lastProgressLoc = { ...position };
        session.activeMoveGoal.stalledSamples = moveTo.MOVE_STALL_SAMPLES - 1;
        moveTo(session, actor, {
            from: { ...position },
            to: { ...destination }
        });
        assert.strictEqual(findPathCalls, 2, 'a repeatedly motionless active goal should automatically replan');
        assert.strictEqual(packets.length, 3, 'stalled-route recovery should emit one StopMove and one meaningful movement packet');
        assert.strictEqual(packets[1].packet[0], 0x47, 'stalled-route recovery should stop the previous C4 client route');

        const recoveredTimer = session.moveTimer;
        moveTo(session, actor, {
            from: { ...position },
            to: { ...destination },
            forceRepath: true
        });
        assert.strictEqual(findPathCalls, 3, 'forceRepath should deliberately replace the active route');
        assert.strictEqual(packets.length, 5, 'forced replacement should emit one StopMove and one meaningful movement packet');
        assert.strictEqual(packets[3].packet[0], 0x47, 'forced replacement should stop the previous C4 client route');
        assert.notStrictEqual(session.moveTimer, recoveredTimer, 'forced replacement should install a new interpolator');

        await wait(150);
        assert.strictEqual(packets.length, 5, 'route completion must not reveal a delayed near-start micro-movement packet');
        assert.strictEqual(session.activeMoveGoal, null, 'arrival should clear the active movement goal');
        assert.strictEqual(actor.state.fetchTowards(), false, 'arrival should clear the movement state');

        position.locX = 100;
        position.locY = 200;
        runSpeed = 1000;
        GeodataEngine.findPath = (startX, startY, startZ, endX, endY, endZ) => [
            { locX: startX, locY: startY, locZ: startZ },
            { locX: endX, locY: endY, locZ: endZ }
        ];
        moveTo(session, actor, {
            from: { ...position },
            to: { locX: 1100, locY: 200, locZ: -300 }
        });
        const blockedUntil = Date.now() + 350;
        while (Date.now() < blockedUntil) { /* emulate a delayed event loop callback */ }
        await wait(30);
        assert(
            position.locX >= 400,
            `movement must catch up from elapsed time after scheduler delay (x=${position.locX})`
        );
        assert(
            position.locX < 1100,
            'a delayed callback before the segment deadline must not finish the route early'
        );
    } finally {
        actor.automation.abortAll(actor, { notifyClient: false });
        RuntimeWorld.user = originalWorldUser;
        GeodataEngine.findPath = originalFindPath;
        GeodataEngine.hasLineOfSight = originalHasLineOfSight;
        GeodataEngine.getHeight = originalGetHeight;
    }

    console.log('Bot movement goal checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
