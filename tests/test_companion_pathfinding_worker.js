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

function issueMove(fixture, to, targetActor = null, options = {}) {
    return moveTo(fixture.session, fixture.actor, {
        from: { ...fixture.position },
        to: { ...to },
        ...options,
        ...(targetActor ? { targetActor } : {})
    });
}

function makeAutonomous(fixture) {
    fixture.session.partyCompanion = false;
    delete fixture.session.followPlayerSession;
    return fixture;
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

        const autonomousFixture = makeAutonomous(companionFixture(
            realPool,
            { locX: 83384, locY: 149256, locZ: -3400 }
        ));
        const autonomousPending = issueMove(
            autonomousFixture,
            { locX: 83265, locY: 150461, locZ: -3514 },
            null,
            { pathMaxNodes: 30000, arrivalRadius: 16 }
        );
        assert.strictEqual(autonomousPending.strategy, 'worker_pending',
            'an expensive autonomous town route must leave the game thread immediately');
        await autonomousFixture.session.pendingPathRequest.promise;
        assert.strictEqual(synchronousFindPathCalls, 0,
            'autonomous town errands must not execute A* on the game thread');
        assert.strictEqual(autonomousFixture.session.lastPathfinding.strategy, 'worker_geodata');
        assert.strictEqual(autonomousFixture.session.lastPathfinding.routeUsable, true,
            'the real Giran route to Groot must use the requested errand budget');
        assert.strictEqual(autonomousFixture.session.lastPathfinding.maxNodes, 30000);
        assert.strictEqual(autonomousFixture.session.lastPathfinding.arrivalRadius, 16);
        stopMove(autonomousFixture);

        const helvetiaFixture = makeAutonomous(companionFixture(
            realPool,
            { locX: 80456, locY: 147864, locZ: -3504 }
        ));
        issueMove(
            helvetiaFixture,
            { locX: 83396, locY: 148144, locZ: -3404 },
            null,
            { pathMaxNodes: 30000, arrivalRadius: 64 }
        );
        const helvetiaSegment = { ...helvetiaFixture.session.townRoutePlan.waypoint };
        assert.notDeepStrictEqual(helvetiaSegment, { locX: 83396, locY: 148144, locZ: -3404 },
            'a long Helvetia-to-gatekeeper trip must begin with one bounded town segment');
        await helvetiaFixture.session.pendingPathRequest.promise;
        assert.strictEqual(helvetiaFixture.session.lastPathfinding.strategy, 'worker_town_segment');
        assert.strictEqual(helvetiaFixture.session.lastPathfinding.routeUsable, true,
            'the first varied Giran segment must remain geodata-reachable');
        assert.strictEqual(synchronousFindPathCalls, 0,
            'segmented town movement must keep A* off the game thread');
        stopMove(helvetiaFixture);

        const shopEgressFixture = makeAutonomous(companionFixture(
            realPool,
            { locX: 80348, locY: 147752, locZ: -3506 }
        ));
        shopEgressFixture.session.townNpcApproach = {
            key: 'shopping:0:7081:80518:147922:-3506:32768',
            phase: 'interaction'
        };
        issueMove(
            shopEgressFixture,
            { locX: 80467, locY: 147871, locZ: -3506 },
            null,
            { pathMaxNodes: 30000, arrivalRadius: 16 }
        );
        await shopEgressFixture.session.pendingPathRequest.promise;
        assert(shopEgressFixture.session.townNpcEgress?.path?.length >= 2,
            'the final geodata ingress segment to a shop must be retained for a safe exit');
        stopMove(shopEgressFixture);
        Object.assign(shopEgressFixture.position, shopEgressFixture.session.townNpcEgress.path[0]);

        const retryResult = issueMove(
            shopEgressFixture,
            { locX: 80467, locY: 147871, locZ: -3506 },
            null,
            { pathMaxNodes: 30000, arrivalRadius: 16 }
        );
        assert.notStrictEqual(retryResult.strategy, 'town_shop_egress',
            'retrying the same active NPC approach must not send the bot back out of the shop');
        assert(shopEgressFixture.session.townNpcEgress,
            'the valid ingress path should remain available until the interaction finishes');
        await shopEgressFixture.session.pendingPathRequest.promise;
        stopMove(shopEgressFixture);

        delete shopEgressFixture.session.townNpcApproach;
        const egressResult = issueMove(
            shopEgressFixture,
            { locX: 83396, locY: 148144, locZ: -3404 },
            null,
            { pathMaxNodes: 30000, arrivalRadius: 64 }
        );
        assert.strictEqual(egressResult.strategy, 'town_shop_egress',
            'a bot leaving a shop must first reverse its known-valid ingress segment');
        assert.strictEqual(shopEgressFixture.session.pendingPathRequest, null,
            'replaying a known ingress segment must not enqueue another A* search');
        assert.strictEqual(shopEgressFixture.session.townNpcEgress, undefined,
            'the saved shop exit must be consumed once instead of becoming a rail');
        stopMove(shopEgressFixture);

        const gludioShopFixture = makeAutonomous(companionFixture(
            realPool,
            { locX: -12736, locY: 122816, locZ: -3112 }
        ));
        issueMove(
            gludioShopFixture,
            { locX: -13908, locY: 123394, locZ: -3116 },
            null,
            { pathMaxNodes: 30000, arrivalRadius: 16 }
        );
        await gludioShopFixture.session.pendingPathRequest.promise;
        assert.strictEqual(gludioShopFixture.session.lastPathfinding.routeUsable, true,
            'the real Gludio route from town center to Lundy must stay off-thread and usable');
        stopMove(gludioShopFixture);

        const gludioGatekeeperFixture = makeAutonomous(companionFixture(
            realPool,
            { locX: -13908, locY: 123394, locZ: -3116 }
        ));
        issueMove(
            gludioGatekeeperFixture,
            { locX: -12736, locY: 122744, locZ: -3114 },
            null,
            { pathMaxNodes: 30000, arrivalRadius: 16 }
        );
        await gludioGatekeeperFixture.session.pendingPathRequest.promise;
        assert.strictEqual(gludioGatekeeperFixture.session.lastPathfinding.routeUsable, true,
            'the real Gludio route from Lundy to Bella must stay off-thread and usable');
        assert.strictEqual(synchronousFindPathCalls, 0,
            'Giran and Gludio town errands must keep all expensive A* work out of the game thread');
        stopMove(gludioGatekeeperFixture);
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

        const budgetRequests = [];
        const budgetPool = {
            request(request) {
                budgetRequests.push(request);
                return Promise.resolve([
                    { locX: request.startX, locY: request.startY, locZ: request.startZ },
                    { locX: request.endX, locY: request.endY, locZ: request.endZ }
                ]);
            },
            cancel() { return false; }
        };
        const budgetFixture = companionFixture(budgetPool, { locX: 0, locY: 0, locZ: 0 });
        issueMove(budgetFixture, { locX: 1000, locY: 0, locZ: 0 });
        await budgetFixture.session.pendingPathRequest.promise;
        assert.strictEqual(
            budgetRequests[0].maxNodes,
            moveTo.COMPANION_PATH_MAX_NODES,
            'hot companions should receive enough worker budget for real town detours'
        );
        stopMove(budgetFixture);

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
