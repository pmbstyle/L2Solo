process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');

require('../src/Global');

const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { PAGE_BYTES } = require('../src/GameServer/Bot/Population/ColdMessagePages');
const StateWire = require('../src/GameServer/Bot/Population/ColdStateWire');
// Snapshot fixtures have no SQLite connection. Exercise real batched hydration
// against an empty repository while keeping transport and cache code intact.
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const ClanSocial = invoke('GameServer/Clan/ClanSocialRuntime');
const originalRepository = Memory.repository;
const originalClanRefresh = ClanSocial.refresh;
Memory.repository = { loadMany: async ids => ids.map(Policy.empty) };
// Clan social persistence has its own suite; this fixture has no clans or database.
ClanSocial.refresh = async () => {};

function setup() {
    const coordinator = new ColdSimulationCoordinator();
    const messages = [];
    coordinator.worker = {};
    coordinator.workerEpoch = 'snapshot-test';
    coordinator.ready = true;
    coordinator.started = true;
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
    const originalEveryState = LifeState.everyState;
    let fullCalls = 0;
    LifeState.everyState = () => {
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
    LifeState.everyState = () => Array.from({ length: 130 }, (_, index) => ({
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

    // A native bag can exceed a page without exceeding the number of item
    // types. Keep every physical instance, including enchant and object ID.
    const largeState = { characterId: 1, phase: 'cold', inventory: { 952: {
        selfId: 952, amount: 4160, equipped: false, stackable: false,
        instances: Array.from({ length: 4160 }, (_, i) => ({ id: 7000000 + i,
            amount: 1, enchant: i % 7, equipped: false, slot: 0 })) } } };
    assert(Protocol.byteLength(largeState) > Protocol.MAX_MESSAGE_BYTES);
    const packed = StateWire.packState(largeState);
    assert(Protocol.byteLength(packed) < PAGE_BYTES);
    assert.deepStrictEqual(StateWire.unpackState(packed), largeState);
    assert.strictEqual(typeof largeState.inventory[952].instances[0].id, 'number', 'packing must not mutate canonical bags');
    const command = { requests: [{ kind: 'lifecycle', state: largeState, precomputedPlan: { plannedState: largeState },
        precomputedResult: { patch: { inventory: largeState.inventory } } }] };
    const packedCommand = StateWire.packPayload('command_request', command);
    assert.deepStrictEqual(StateWire.unpackPayload('command_request', packedCommand), command,
        'post-trade lifecycle commands must preserve their complete inventory patch');
    const commandMessage = Protocol.envelope('command_request', 'e', packedCommand);
    assert(Protocol.omitPlannedStates(commandMessage));
    assert(Protocol.byteLength(commandMessage) < PAGE_BYTES, 'native reconstruction removes only the redundant planned state');
    assert.throws(() => StateWire.unpackState({ ...packed,
        inventoryInstanceColumns: { 952: ['id'] } }), /invalid_inventory_wire/);
    for (const mode of ['full', 'incremental', 'snapshot_page', 'commit_ack', 'command_ack']) {
        const { coordinator, messages } = setup();
        delete coordinator.post;
        coordinator.worker.postMessage = message => messages.push(message);
        coordinator.reconcileOrphanedBackgroundParties = async () => {};
        LifeState.everyState = () => [largeState];
        if (mode === 'full') assert.strictEqual((await coordinator.sendFullSnapshot()).ok, true);
        else if (mode === 'incremental') assert.strictEqual((await coordinator.sendIncrementalEntries([largeState], 32)).ok, true);
        else {
            const field = mode === 'snapshot_page' ? 'rows' : 'results';
            const row = { characterId: 1, ok: false, state: largeState,
                ...(mode === 'commit_ack' ? { proposalId: '1:1' } : {}) };
            assert.strictEqual(coordinator.postCollections(mode, { [field]: [row] }), 1, mode);
        }
        assert(messages.length > 0, mode);
        const message = messages.at(-1);
        assert(Protocol.byteLength(message) < Protocol.MAX_MESSAGE_BYTES);
        const payload = StateWire.unpackPayload(message.type, message.payload);
        const rows = payload.rows || payload.results;
        assert.deepStrictEqual(rows[0].state, largeState, mode);
        if (mode === 'full') assert.strictEqual(message.payload.done, true, 'a large bag must not suppress bootstrap readiness');
    }

    // A critical publisher already running when the worker announces running
    // must finish, then replay the requested FULL bootstrap rather than dirty.
    const deferredBootstrap = setup();
    let releaseCritical, criticalStarted;
    const criticalGate = new Promise(resolve => { releaseCritical = resolve; });
    const enteredCritical = new Promise(resolve => { criticalStarted = resolve; });
    const sendIncremental = deferredBootstrap.coordinator.sendIncrementalEntries.bind(deferredBootstrap.coordinator);
    deferredBootstrap.coordinator.sendIncrementalEntries = async (...args) => {
        criticalStarted(); await criticalGate; return sendIncremental(...args);
    };
    LifeState.everyState = () => [{ characterId: 77, phase: 'cold' }];
    deferredBootstrap.coordinator.markDirty({ characterId: 77, phase: 'cold' }, { critical: true });
    await enteredCritical;
    assert.strictEqual(await deferredBootstrap.coordinator.sendSnapshots(true), false);
    assert.strictEqual(deferredBootstrap.coordinator.snapshotBootstrapPending, true);
    releaseCritical();
    await deferredBootstrap.coordinator.criticalSnapshotInFlight;
    const bootstrapDeadline = Date.now() + 2000;
    while (!deferredBootstrap.messages.some(message => message.payload.initial && message.payload.done)) {
        assert(Date.now() < bootstrapDeadline, 'deferred full bootstrap must publish its completion marker');
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    const critical = setup();
    critical.coordinator.markDirty({ characterId: 99, phase: 'cold', revision: 2 }, {
        reason: 'death',
        critical: true
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(critical.messages[0].payload.priority, 'P0', 'critical state must bypass ordinary refresh');
    assert.strictEqual(critical.messages[0].payload.rows[0].state.characterId, 99);

    // A committed memory episode reaches the worker as a 'memory' table row
    // (InteractionMemoryRuntime), not as a re-sent state: no bootstrap case here.

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
        LifeState.everyState = () => states;
        const send = () => mode === 'full' ? coordinator.sendFullSnapshot()
            : coordinator.sendIncrementalEntries(states, 32, 'P0');
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

    // A bot seeded while the worker's full snapshot is on the wire (the seeder
    // runs beside the worker's boot) is not in the rows the snapshot read at
    // its start; it still reaches the worker and gets its first step.
    const seededDuringFull = setup();
    LifeState.everyState = () => [{ characterId: 501, phase: 'cold', activity: 'hunting',
        timing: { nextResolveAt: 1000 }, simulation: { revision: 1 } }];
    const seeded = { characterId: 502, phase: 'cold', activity: 'hunting',
        timing: { nextResolveAt: 1000 }, simulation: { revision: 0 } };
    seededDuringFull.coordinator.reconcileOrphanedBackgroundParties = async () => [];
    let seededMarked = false;
    seededDuringFull.coordinator.ensureCraftRecipes = async () => {
        if (!seededMarked) seededDuringFull.coordinator.markDirty(seeded, { reason: 'seed' });
        seededMarked = true;
    };
    await seededDuringFull.coordinator.sendSnapshots(true);
    const seededDeadline = Date.now() + 3000;
    const sentIds = () => seededDuringFull.messages.flatMap(message => message.payload.rows.map(row => row.state.characterId));
    while (!sentIds().includes(502)) {
        assert(Date.now() < seededDeadline, 'a bot seeded during the full snapshot must reach the worker');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    {
        const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
        const kernel = new ColdSimulationKernel({ now: () => 2000, resolveSolo: () => null });
        kernel.upsertMany(seededDuringFull.messages.flatMap(message => message.payload.rows));
        assert(kernel.dueCandidates(2000, 8).some(entry => entry.characterId === 502),
            'the seeded bot is due for its first step in the worker');
    }
    clearTimeout(seededDuringFull.coordinator.snapshotContinuationTimer);

    LifeState.everyState = originalEveryState;
    const sliced = setup();
    const governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
    const originalAdmit = governor.admit;
    const originalComplete = governor.complete;
    const originalNow = Date.now;
    let clock = originalNow();
    let completed = 0;
    try {
        Date.now = () => clock;
        for (let id = 201; id <= 203; id++) sliced.coordinator.markDirty({ characterId: id, phase: 'cold' });
        // Each row's preparation costs 20 ms of the slice.
        sliced.coordinator.ensureCraftRecipes = async () => { clock += 20; };
        governor.admit = () => ({ ok: true, lease: { budgetMs: 1 } });
        governor.complete = () => { completed++; };
        const first = await sliced.coordinator.sendSnapshots(false, true);
        assert.strictEqual(first.rowsSent, 1, 'deadline must bound serialization work');
        assert.strictEqual(sliced.coordinator.snapshotQueue.size(), 2, 'unsent suffix must remain queued');
        assert.strictEqual(completed, 1, 'continuation must account for its actual work');
        assert(sliced.coordinator.snapshotContinuationTimer, 'remaining work must schedule a continuation');
        governor.admit = () => ({ ok: false });
        assert.strictEqual(await sliced.coordinator.sendSnapshots(false, true), false);
        assert.strictEqual(sliced.messages.length, 1, 'denied budget must not send work');
        governor.admit = () => ({ ok: true, lease: { budgetMs: 1 } });
        Date.now = originalNow;
        await new Promise(resolve => setTimeout(resolve, 350));
        assert.strictEqual(sliced.coordinator.snapshotQueue.size(), 0, 'timer must drain the retained suffix without a reconcile tick');
        assert.deepStrictEqual(sliced.messages.flatMap(message => message.payload.rows.map(row => row.state.characterId)), [201, 202, 203]);
    } finally {
        Date.now = originalNow;
        governor.admit = originalAdmit;
        governor.complete = originalComplete;
        clearTimeout(sliced.coordinator.snapshotContinuationTimer);
    }
    const nativeTravel = setup();
    const previousCachedState = LifeState.cachedState;
    const waitingMeeting = { characterId: 930021, phase: 'cold', activity: 'hunting', updatedAt: 1000,
        stats: { tradeMeeting: [7, 1] }, timing: { nextResolveAt: 2000 },
        simulation: { revision: 40 } };
    const paidLeg = { ...waitingMeeting, activity: 'traveling', updatedAt: 1001,
        stats: { ...waitingMeeting.stats, travel: { reason: 'trade_meeting', arrivalAt: 3000 } },
        timing: { nextResolveAt: 3000 }, simulation: { ...waitingMeeting.simulation, revision: 41 } };
    let authoritative = waitingMeeting;
    try {
        LifeState.cachedState = id => id === waitingMeeting.characterId ? authoritative : previousCachedState.call(LifeState, id);
        // The previous page is still hydrating while the native leg commits.
        // A deferred incoming/memory notification carries its pre-trip object.
        nativeTravel.coordinator.criticalSnapshotInFlight = Promise.resolve();
        nativeTravel.coordinator.notifyState(waitingMeeting);
        authoritative = paidLeg;
        nativeTravel.coordinator.notifyState(paidLeg);
        nativeTravel.coordinator.markDirty(waitingMeeting, { critical: true, reason: 'trade_incoming' });
        nativeTravel.coordinator.criticalSnapshotInFlight = null;
        await nativeTravel.coordinator.flushCriticalSnapshots();
        const published = nativeTravel.messages.at(-1).payload.rows[0].state;
        assert.strictEqual(published.simulation.revision, 41,
            'a delayed pre-trip notification must not replace a newer native paid leg');
        assert.strictEqual(published.activity, 'traveling');
        const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
        const kernel = new ColdSimulationKernel({ now: () => 4000, resolveSolo: () => null });
        kernel.upsertMany(nativeTravel.messages.flatMap(message => message.payload.rows));
        assert.strictEqual(kernel.dueCandidates(4000, 1)[0]?.characterId, waitingMeeting.characterId,
            'the actual published leg must retain resolver coverage for arrival');
    } finally {
        LifeState.cachedState = previousCachedState;
        clearTimeout(nativeTravel.coordinator.snapshotContinuationTimer);
    }
    console.log('Cold coordinator incremental refresh, cooperative full bootstrap, P0 bypass and native trip publication checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Memory.repository = originalRepository;
    ClanSocial.refresh = originalClanRefresh;
});
