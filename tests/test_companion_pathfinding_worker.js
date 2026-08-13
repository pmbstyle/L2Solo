const assert = require('assert');
const path = require('path');

require('../src/Global');

const Automation = invoke('GameServer/Automation');
const moveTo = invoke('GameServer/Actor/Generics/MoveTo');
const RuntimeWorld = invoke('GameServer/World/World');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const PoolSingleton = invoke('GameServer/Geodata/PathfindingWorkerPool');
const { BoundedPathfindingWorkerPool } = PoolSingleton;

class BotSession {}

function companionFixture(pool, start = { locX: 53027, locY: 102938, locZ: -1064 }) {
    const packets = [];
    const position = { ...start };
    const leaderPosition = { ...start };
    const leaderSession = {
        accountId: 'player_companion_path_test',
        actor: {
            fetchIsOnline: () => true,
            fetchId: () => 7001,
            fetchLocX: () => leaderPosition.locX,
            fetchLocY: () => leaderPosition.locY,
            fetchLocZ: () => leaderPosition.locZ
        }
    };
    const session = new BotSession();
    Object.assign(session, {
        accountId: 'bot_companion_path_test',
        partyCompanion: true,
        followPlayerSession: leaderSession,
        pathfindingWorkerPool: pool,
        dataSendToMeAndOthers(packet, actor) { packets.push({ packet, actor }); }
    });
    const state = {
        towards: false,
        inMotion() { return this.towards; },
        fetchTowards() { return this.towards; },
        setTowards(value) { this.towards = value; }
    };
    const actor = {
        session,
        state,
        effects: {},
        isDead: () => false,
        isBlocked: () => false,
        fetchId: () => 7101,
        fetchName: () => 'WorkerCompanion',
        fetchIsOnline: () => true,
        fetchLocX: () => position.locX,
        fetchLocY: () => position.locY,
        fetchLocZ: () => position.locZ,
        fetchHead: () => 0,
        fetchCollectiveRunSpd: () => 120,
        setLocXYZ(next) { Object.assign(position, next); }
    };
    actor.automation = new Automation();
    session.actor = actor;
    RuntimeWorld.user = { sessions: [session, leaderSession] };
    return { session, actor, leaderSession, packets, position, leaderPosition };
}

function issueMove(fixture, to, targetActor = null) {
    return moveTo(fixture.session, fixture.actor, {
        from: { ...fixture.position },
        to: { ...to },
        ...(targetActor ? { targetActor } : {})
    });
}

function stopMove(fixture) {
    if (fixture.session.moveTimer) {
        clearInterval(fixture.session.moveTimer);
        fixture.session.moveTimer = null;
    }
    fixture.actor.state.setTowards(false);
}

async function run() {
    const originalFindPath = GeodataEngine.findPath;
    const originalHasLineOfSight = GeodataEngine.hasLineOfSight;
    let synchronousFindPathCalls = 0;
    GeodataEngine.findPath = () => {
        synchronousFindPathCalls++;
        throw new Error('companion path must not execute A* on the game thread');
    };
    GeodataEngine.hasLineOfSight = () => false;

    try {
        const realPool = new BoundedPathfindingWorkerPool({ size: 1, queueLimit: 4 });
        const realFixture = companionFixture(realPool);
        const pending = issueMove(realFixture, { locX: 53327, locY: 102938, locZ: -1064 });
        assert.strictEqual(pending.strategy, 'worker_pending', 'eligible companion routes must return without blocking the game thread');
        const realPromise = realFixture.session.pendingPathRequest.promise;
        await realPromise;
        assert.strictEqual(synchronousFindPathCalls, 0, 'eligible companion movement must never call synchronous findPath');
        assert.strictEqual(realFixture.session.lastPathfinding.strategy, 'worker_geodata');
        assert.strictEqual(realFixture.session.lastPathfinding.worker, true);
        assert.strictEqual(realFixture.actor.state.towards, 'move', 'the main thread must apply a current real-worker path');
        stopMove(realFixture);
        await realPool.shutdown();

        const delayedPool = new BoundedPathfindingWorkerPool({
            size: 1,
            queueLimit: 2,
            workerPath: path.join(__dirname, 'fixtures', 'companion_path_worker.js')
        });
        const staleFixture = companionFixture(delayedPool, { locX: 0, locY: 0, locZ: 0 });
        issueMove(staleFixture, { locX: 1000, locY: 0, locZ: 0 });
        const stalePromise = staleFixture.session.pendingPathRequest.promise;
        issueMove(staleFixture, { locX: 2000, locY: 0, locZ: 0 });
        const latestPromise = staleFixture.session.pendingPathRequest.promise;
        await Promise.all([stalePromise, latestPromise]);
        assert.strictEqual(staleFixture.session.lastPathfinding.routedTo.locX, 2000,
            'latest-only routing must prevent a stale target from being applied');
        assert(delayedPool.stats().stale >= 1, 'replacing a target must cancel stale queued or in-flight work');
        stopMove(staleFixture);

        const movedFixture = companionFixture(delayedPool, { locX: 0, locY: 0, locZ: 0 });
        issueMove(movedFixture, { locX: 1000, locY: 0, locZ: 0 });
        const movedPromise = movedFixture.session.pendingPathRequest.promise;
        movedFixture.position.locY = 25;
        await movedPromise;
        assert.strictEqual(movedFixture.actor.state.towards, false,
            'an actor position change must invalidate the immutable worker snapshot');
        assert.strictEqual(movedFixture.session.pendingPathRequest, null);

        const targetFixture = companionFixture(delayedPool, { locX: 0, locY: 0, locZ: 0 });
        issueMove(targetFixture, { locX: 1000, locY: 0, locZ: 0 }, targetFixture.leaderSession.actor);
        const targetPromise = targetFixture.session.pendingPathRequest.promise;
        targetFixture.leaderPosition.locY = 200;
        await targetPromise;
        assert.strictEqual(targetFixture.actor.state.towards, false,
            'material target movement must invalidate a companion-follow snapshot');
        assert.strictEqual(targetFixture.session.pendingPathRequest, null);

        const abortedFixture = companionFixture(delayedPool, { locX: 0, locY: 0, locZ: 0 });
        issueMove(abortedFixture, { locX: 1000, locY: 0, locZ: 0 });
        const abortedPromise = abortedFixture.session.pendingPathRequest.promise;
        abortedFixture.actor.automation.abortAll(abortedFixture.actor);
        await abortedPromise;
        assert.strictEqual(abortedFixture.actor.state.towards, false,
            'combat or automation abort must invalidate the route generation');
        assert.strictEqual(abortedFixture.packets.length, 0, 'a cancelled pending path must not emit movement');

        const rejectedPool = {
            request() {
                const error = new Error('synthetic bounded queue rejection');
                error.code = 'QUEUE_FULL';
                return Promise.reject(error);
            },
            cancel() { return false; }
        };
        const fallbackFixture = companionFixture(rejectedPool, { locX: 0, locY: 0, locZ: 0 });
        GeodataEngine.hasLineOfSight = () => true;
        issueMove(fallbackFixture, { locX: 1000, locY: 0, locZ: 0 });
        await fallbackFixture.session.pendingPathRequest.promise;
        assert.strictEqual(fallbackFixture.session.lastPathfinding.strategy, 'worker_geodata_error_fallback');
        assert.strictEqual(fallbackFixture.session.lastPathfinding.error, 'QUEUE_FULL');
        assert.strictEqual(fallbackFixture.actor.state.towards, 'move',
            'a clear line may use the existing direct fallback when the bounded queue rejects work');
        stopMove(fallbackFixture);

        const shortPool = {
            request() { throw new Error('short clear routes must not pay worker latency'); },
            cancel() { return false; }
        };
        const shortFixture = companionFixture(shortPool, { locX: 0, locY: 0, locZ: 0 });
        const shortResult = issueMove(shortFixture, { locX: moveTo.COMPANION_DIRECT_DISTANCE, locY: 0, locZ: 0 });
        assert.strictEqual(shortResult.strategy, 'short_direct');
        assert.strictEqual(shortFixture.actor.state.towards, 'move');
        stopMove(shortFixture);

        await delayedPool.shutdown();
    } finally {
        GeodataEngine.findPath = originalFindPath;
        GeodataEngine.hasLineOfSight = originalHasLineOfSight;
    }

    console.log('Companion pathfinding worker checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
