const assert = require('assert');
const EventEmitter = require('events');

require('../src/Global');

const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

// Every answer to the worker about a bot carries a fresh context whose route
// is computed from the state just written, accepted or rejected alike.
class FakeWorker extends EventEmitter {
    constructor() { super(); this.messages = []; }
    postMessage(message) { this.messages.push(message); }
    terminate() { return Promise.resolve(1); }
}

(async () => {
    const originals = { cachedState: LifeState.cachedState, releaseBatch: Owner.releaseBatch };
    const states = new Map([1, 2].map((id) => [id, { characterId: id, level: 20, phase: 'cold', activity: 'hunting',
        loc: { locX: 10, locY: 20, locZ: -30 }, stats: { probe: id }, inventory: {} }]));
    LifeState.cachedState = (id) => states.get(Number(id)) || null;
    Owner.releaseBatch = async (tokens) => tokens.map((token) => ({ ok: true, characterId: token.characterId }));
    try {
        const coordinator = new ColdSimulationCoordinator({ WorkerClass: FakeWorker, workerPath: 'fake-worker.js' });
        const routed = [];
        coordinator.routeFor = (state) => {
            routed.push(state.characterId);
            return { spotId: `route_${state.characterId}`, stats: state.stats };
        };
        const posted = [];
        coordinator.postCollections = (type, payload) => { posted.push({ type, payload }); return 1; };

        await coordinator.handleCommitResults([
            { ok: true, characterId: 1, revision: 2 },
            { ok: false, characterId: 2, reason: 'stale_revision', proposal: { token: { characterId: 2 } } }
        ]);
        const ack = posted.find((message) => message.type === 'commit_ack');
        assert(ack, 'commit results are acknowledged');
        assert.deepStrictEqual(routed, [1, 2], 'a route is computed for every acknowledged bot');
        assert.deepStrictEqual(ack.payload.results.map((result) => result.context.route?.spotId), ['route_1', 'route_2'],
            'accepted and rejected commits both carry a route');
        assert.strictEqual(ack.payload.results[0].context.route.stats, states.get(1).stats,
            'the route is computed from the cached state that was just written');

        routed.length = 0;
        await coordinator.handleReleaseRequest({ msgId: 7, payload: { releases: [{ token: { characterId: 1 } }] } });
        const release = posted.find((message) => message.type === 'release_ack');
        assert.deepStrictEqual(routed, [1]);
        assert.strictEqual(release.payload.results[0].context.route.spotId, 'route_1', 'a release carries a route too');
        console.log('test_cold_ack_route passed');
    } finally {
        LifeState.cachedState = originals.cachedState;
        Owner.releaseBatch = originals.releaseBatch;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
