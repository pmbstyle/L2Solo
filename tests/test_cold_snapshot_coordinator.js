const assert = require('assert');

require('../src/Global');

const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { PAGE_BYTES } = require('../src/GameServer/Bot/Population/ColdMessagePages');
// Snapshot fixtures have no SQLite connection. Exercise real batched hydration
// against an empty repository while keeping transport and cache code intact.
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
Memory.repository = { loadMany: async ids => ids.map(Policy.empty) };

function setup() {
    const coordinator = new ColdSimulationCoordinator();
    const messages = [];
    coordinator.worker = {};
    coordinator.workerEpoch = 'snapshot-test';
    coordinator.ready = true;
    coordinator.started = true;
    coordinator.contextIndex = () => ({ spots: new Map(), parties: new Map() });
    coordinator.snapshotEntry = (state) => ({ state, context: {} });
    coordinator.post = (type, payload) => {
        messages.push({ type, payload });
        return `${type}:${messages.length}`;
    };
    return { coordinator, messages };
}

(async () => {
    Metrics.schedulerState = {
        ...Metrics.schedulerState,
        mode: 'player',
        realPlayers: 1,
        lagMs: 0
    };

    const incremental = setup();
    const originalAllStates = LifeState.allStates;
    let fullCalls = 0;
    LifeState.allStates = () => {
        fullCalls += 1;
        return [];
    };
    incremental.coordinator.markDirty({ characterId: 7, phase: 'cold', revision: 1 }, { reason: 'resolve' });
    const incrementalResult = await incremental.coordinator.sendSnapshots(false);
    assert.strictEqual(incrementalResult.ok, true);
    assert.strictEqual(fullCalls, 0, 'periodic refresh must not walk all LifeState rows');
    assert.strictEqual(incremental.messages[0].payload.rows.length, 1);
    assert.strictEqual(incremental.messages[0].payload.initial, false);

    const full = setup();
    LifeState.allStates = () => Array.from({ length: 130 }, (_, index) => ({
        characterId: index + 1,
        phase: 'cold',
        revision: 1
    }));
    const fullResult = await full.coordinator.sendSnapshots(true);
    assert.strictEqual(fullResult.ok, true);
    assert(full.messages.length >= 3, 'full bootstrap must be split into multiple pages');
    assert(full.messages.every((message) => message.payload.rows.length <= 48), 'full pages must stay bounded');
    assert.strictEqual(full.messages.at(-1).payload.done, true);
    assert(full.coordinator.snapshot().snapshots.yields >= 3, 'full pages must yield to the main loop');

    const critical = setup();
    critical.coordinator.markDirty({ characterId: 99, phase: 'cold', revision: 2 }, {
        reason: 'death',
        critical: true
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(critical.messages[0].payload.priority, 'P0', 'critical state must bypass ordinary refresh');
    assert.strictEqual(critical.messages[0].payload.rows[0].state.characterId, 99);

    const duringBootstrap = setup();
    const sharedCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const previous = { cachedState: LifeState.cachedState, markDirty: sharedCoordinator.markDirty,
        initial: sharedCoordinator.snapshotInFlightInitial };
    try {
        const state = { characterId: 99, phase: 'cold' };
        LifeState.cachedState = () => state;
        sharedCoordinator.snapshotInFlightInitial = true;
        duringBootstrap.coordinator.snapshotInFlightInitial = true;
        sharedCoordinator.markDirty = (value, options) => duringBootstrap.coordinator.markDirty(value, options);
        Memory.events.onCommit(99);
        assert.strictEqual(duringBootstrap.coordinator.snapshotQueue.size(), 1, 'memory committed during bootstrap must not be dropped');
        assert.strictEqual(await duringBootstrap.coordinator.flushCriticalSnapshots(), false);
        duringBootstrap.coordinator.snapshotInFlightInitial = false;
        await duringBootstrap.coordinator.flushCriticalSnapshots();
        assert.strictEqual(duringBootstrap.messages[0].payload.rows[0].state.characterId, 99);
    } finally {
        LifeState.cachedState = previous.cachedState;
        sharedCoordinator.markDirty = previous.markDirty;
        sharedCoordinator.snapshotInFlightInitial = previous.initial;
    }

    // Exercise actual envelope validation with Unicode payloads large enough
    // to hit the byte limit before the row limit, in both delivery paths.
    for (const mode of ['full', 'incremental']) {
        const { coordinator, messages } = setup();
        delete coordinator.post;
        coordinator.worker.postMessage = message => messages.push(message);
        coordinator.reconcileOrphanedBackgroundParties = async () => {};
        let serializations = 0;
        const states = Array.from({ length: 65 }, (_, index) => ({
            characterId: index + 1,
            phase: 'cold',
            stats: {
                text: 'Поляна🌲'.repeat(1600 + index),
                toJSON() {
                    serializations++;
                    return { text: this.text };
                }
            }
        }));
        LifeState.allStates = () => states;
        const send = () => mode === 'full' ? coordinator.sendFullSnapshot()
            : coordinator.sendIncrementalEntries(states, {}, 32, 'P0');
        const result = await send();
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.rowsSent, states.length);
        assert.strictEqual(result.pagesSent, messages.length);
        assert.deepStrictEqual(messages.flatMap(message => message.payload.rows.map(row => row.state)), states,
            'byte pagination must deliver every state in order without truncation');
        assert(serializations <= states.length * 3,
            'page sizing and final validation must perform linear serialization work');
        assert(messages.length > 3, 'the fixture must exercise byte-limited pages');
        for (const [index, message] of messages.entries()) {
            assert(Protocol.byteLength(message) <= PAGE_BYTES, 'full envelope must fit the UTF-8 page budget');
            assert.strictEqual(message.payload.initial, mode === 'full');
            assert.strictEqual(message.payload.done, mode === 'full' && index === messages.length - 1);
            assert.strictEqual(message.payload.priority, mode === 'full' ? undefined : 'P0');
        }

        // A failed send must not claim the unaccepted rows or final marker.
        let attempts = 0;
        const sendPage = coordinator.sendSnapshotPage.bind(coordinator);
        coordinator.sendSnapshotPage = (...args) => ++attempts === 2 ? false : sendPage(...args);
        messages.length = 0;
        const failed = await send();
        assert.strictEqual(failed.ok, false);
        assert.strictEqual(failed.pagesSent, 1);
        assert.strictEqual(failed.rowsSent, messages[0].payload.rows.length);
        assert(!messages.some(message => message.payload.done));
        coordinator.sendSnapshotPage = sendPage;

        // Oversized individual states still fail explicitly; never drop them
        // to make the remaining snapshot appear complete.
        states.splice(0, states.length, { characterId: 1, text: 'x'.repeat(Protocol.MAX_MESSAGE_BYTES) });
        messages.length = 0;
        const oversized = await send();
        assert.strictEqual(oversized.ok, false);
        assert.strictEqual(oversized.rowsSent, 0);
        assert.strictEqual(messages.length, 0);
        assert.strictEqual(coordinator.counters.invalidReasons.out_snapshot_page_message_too_large, 1);

        states.length = 0;
        const empty = await send();
        assert.strictEqual(empty.ok, true);
        assert.strictEqual(empty.rowsSent, 0);
        assert.strictEqual(messages.length, mode === 'full' ? 1 : 0);
        if (mode === 'full') assert.strictEqual(messages[0].payload.done, true);
    }

    LifeState.allStates = originalAllStates;
    console.log('Cold coordinator incremental refresh, cooperative full bootstrap, and P0 bypass checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
