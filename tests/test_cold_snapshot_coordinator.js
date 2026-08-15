const assert = require('assert');

require('../src/Global');

const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

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

    LifeState.allStates = originalAllStates;
    console.log('Cold coordinator incremental refresh, cooperative full bootstrap, and P0 bypass checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
