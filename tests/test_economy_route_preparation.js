'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Routes = require('../src/GameServer/Bot/Economy/EconomicTrip');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdOccupationPlanner } = require('../src/GameServer/Bot/Population/ColdOccupationPlanner');
const Towns = require('../src/GameServer/World/TownRespawn');
const saved = Config.coldHonestTravel;
const nativeObserver = String.raw`
module.exports.nativeRouteProbe = async () => {
    const state = { characterId: 9342, phase: 'cold', updatedAt: 1000, activity: 'shopping', level: 40,
        currentRegion: 'Dion', loc: require('../../World/TownRespawn').towns.dion_town, adena: 100000,
        inventory: { 736: { selfId: 736, amount: 2 } },
        stats: { classId: 57, money: [1375, .001, 0, 0], workshop: { entries: [] } } };
    kernel.states.set(state.characterId, { state, context: {} });
    const originalCreate = occupationPlanner.create;
    // Pin a supported nonzero occupation result at the planner boundary. The
    // actual route job, slot ownership, context and gear reader remain native.
    occupationPlanner.create = input => input.mode === 'occupation' ? {
        iterator: (function* () { yield 'candidate'; return { known: true, recipeId: 20, productId: 1463,
            incomePerHour: input.state.stats.money[0], cycleHours: .25 }; })(), done: false, units: 0
    } : originalCreate(input);
    try {
        const timestamp = Date.now(), workshop = await occupationFor(state, timestamp);
        const positive = occupationPlanner.slots.get(state.characterId);
        const rows = await occupationFor(state, timestamp, {}, 'wish');
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
        const occupancy = currentPlanningOccupancy(timestamp), spots = [];
        const first = Economy.forState(state, { spots, occupancy, timestamp, workshop, routeRows: rows });
        // Capacity may retire the completed planner slot after this build;
        // the gear reader must consume the exact already prepared context.
        occupationPlanner.release(state.characterId);
        const selected = GearPlanSelection.selectAcquisitionPlan(state, null,
            { spots, occupancy, timestamp, preparedEconomy: first });
        return { workshop: workshop.incomePerHour, routeRows: rows.length,
            positiveMode: positive.input.mode, preservedPositive: positive.value === workshop,
            sameEconomy: selected.economy === first, income: selected.economy.workshop.incomePerHour,
            negativeReleased: !routeRequests.has(state.characterId) && !occupationPlanner.slots.has(-state.characterId),
            key: typeof first.inputKey === 'string' && selected.economy.inputKey === first.inputKey };
    } finally { occupationPlanner.create = originalCreate; kernel.states.delete(state.characterId); }
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.routeProbe) return;
    loaded.exports.nativeRouteProbe().then(value => parentPort.postMessage({ probe: true, value }))
        .catch(error => parentPort.postMessage({ probe: true, error: error.stack }));
});`;
function drain(iterator) { let next, units = 0; do { next = iterator.next(); units++; } while (!next.done); return { rows: next.value, units }; }
async function main() {
    Config.coldHonestTravel = true;
    const state = { characterId: 9341, activity: 'shopping', currentRegion: 'Dion', loc: Towns.towns.dion_town,
        inventory: { 736: { amount: 2 } }, stats: { marketReturn: { loc: { locX: 20000, locY: 140000, locZ: -3000 } } } };
    const frame = Routes.frame(state), key = Routes.key(frame);
    assert.equal(Routes.key(state), key, 'route identity carries own inputs only');
    assert(Protocol.economyRouteFrame(frame));
    const prepared = drain(Routes.prepare(frame));
    assert.equal(prepared.rows.length, 16);
    assert(prepared.units > 100, 'geometry and teleport work is yielded before a completed table');
    const reused = drain(Routes.prepare({ ...frame, characterId: 9999 }));
    assert.strictEqual(reused.rows, prepared.rows, 'another owner with the same own route inputs shares the completed table');
    assert.equal(reused.units, 1, 'a shared prepared key performs no edge iteration');
    for (let index = 0; index < 65; index++) drain(Routes.prepare({ ...frame, currentRegion: `Unknown ${index}`, loc: null,
        stats: { karma: 0, marketReturn: null, travel: null } }));
    const evicted = drain(Routes.prepare(frame));
    assert(evicted.units > 100, 'the sixty-four-entry table memo evicts old keys');
    assert.deepEqual(evicted.rows, prepared.rows, 'eviction affects preparation work, never route results');
    const cost = Routes.preparedReader(prepared.rows, { hourAdena: 1000 });
    for (const town of Routes.towns) assert.deepEqual(cost.details(town), Routes.read(frame, town));
    assert.equal(cost('Dion'), 0);
    assert.equal(Routes.preparedReader(null, { hourAdena: 1000 })('Dion'), Infinity,
        'an absent prepared table never expands a route or claims a free source');
    const expensive = Routes.preparedReader(prepared.rows, { hourAdena: 2000 });
    assert.equal(expensive.details('Giran').hours, cost.details('Giran').hours);
    assert(expensive('Giran') >= cost('Giran'), 'the card contains time, not a stale spending budget');
    const payload = { characterId: state.characterId, requestId: 1, key, frame };
    assert(Protocol.validateEnvelope(Protocol.envelope('economy_route_request', 'routes', payload), 'main').ok);
    const result = { characterId: state.characterId, requestId: 1, key, rows: prepared.rows };
    assert(Protocol.validateEnvelope(Protocol.envelope('economy_route_result', 'routes', result), 'worker').ok);
    for (const bad of [{ ...payload, bag: {} }, { ...payload, requestId: '1' },
        { ...payload, key: 'x'.repeat(601) }, { ...payload, frame: { ...frame, phase: 'hot' } }]) {
        assert.equal(Protocol.economyRoutePayload(bad), false);
    }
    for (const rows of [[[true, NaN, 0]], [[false, 0, 0]], [[true, -1, 0]], [[true, 0, 0]],
        Array(15).fill([false, null, null]), Array(17).fill([false, null, null])]) {
        assert.equal(Protocol.economyRoutePayload({ ...result, rows }, true), false);
    }
    const planner = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0,
        capture: (_, input) => input, create: () => ({ units: 0 }), step: work => ++work.units > 100,
        result: () => null, sourceToken: () => 0 });
    planner.request(-1, { mode: 'wish' }, { awaitResult: false });
    planner.request(1, { mode: 'occupation' }, { awaitResult: false });
    planner.portion(); planner.resetSources();
    assert.equal(planner.slots.get(-1).dirty, false, 'market snapshot replacement cannot restart independent route work');
    assert.equal(planner.slots.get(1).dirty, true, 'ordinary source-dependent work keeps its reset fence');
    planner.stop();
    const epoch = 'routes-preparation-test', messages = [];
    const worker = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch, observer: nativeObserver,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') },
        resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => {
        const deadline = Date.now() + 15000;
        while (!predicate()) { if (fault) throw fault; if (Date.now() > deadline) throw Error('route worker timeout');
            await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    const send = (type, value = {}) => worker.postMessage(Protocol.envelope(type, epoch, value));
    try {
        await wait(() => messages.some(message => message.type === 'ready' && message.payload.phase === 'loaded'));
        send('init', { config: { coldHonestTravel: true, heartbeatMs: 100 } });
        await wait(() => messages.some(message => message.type === 'ready' && message.payload.phase === 'running'));
        worker.postMessage({ ...Protocol.envelope('pause', epoch), routeProbe: true });
        await wait(() => messages.some(message => message.probe));
        const probe = messages.find(message => message.probe); if (probe.error) throw Error(probe.error);
        assert.deepEqual(probe.value, { workshop: 1375, routeRows: 16, positiveMode: 'occupation',
            preservedPositive: true, sameEconomy: true, income: 1375, negativeReleased: true, key: true },
        'native wish preparation preserves supported occupation income and gear uses the same context even after slot eviction');
        send('economy_route_request', payload); send('economy_route_request', payload);
        await wait(() => messages.some(message => message.type === 'economy_route_result' && message.payload.requestId === 1));
        assert.deepEqual(messages.find(message => message.type === 'economy_route_result').payload.rows, prepared.rows,
            'the actual isolated worker and main pure generator produce identical route tables');
        assert.equal(messages.filter(message => message.type === 'economy_route_result' && message.payload.requestId === 1).length, 1,
            'same in-flight identity coalesces');
        const changed = Routes.frame({ ...state, currentRegion: 'Giran', loc: Towns.towns.giran_town });
        send('economy_route_request', { ...payload, requestId: 2 });
        send('economy_route_request', { ...payload, requestId: 3, key: Routes.key(changed), frame: changed });
        await wait(() => messages.some(message => message.type === 'economy_route_result' && message.payload.requestId === 3));
        assert.equal(messages.some(message => message.type === 'economy_route_result' && message.payload.requestId === 2), false,
            'a replaced route request cannot publish its old table');
        for (let index = 0; index < 65; index++) send('economy_route_request', {
            ...payload, characterId: 10000 + index, requestId: 100 + index });
        await wait(() => messages.some(message => message.type === 'economy_route_result' && message.payload.requestId === 164));
        assert.deepEqual(messages.find(message => message.type === 'economy_route_result' && message.payload.requestId === 164).payload.rows, [],
            'a saturated frame map refuses new scratch explicitly rather than growing or claiming route evidence');
        for (let index = 0; index < 65; index++) send('fence', { characterId: 10000 + index });
        send('economy_route_request', { ...payload, requestId: 4 }); send('fence', { characterId: state.characterId });
        await wait(() => messages.some(message => message.type === 'fence_ack' && message.payload.characterId === state.characterId));
        send('shutdown'); await wait(() => messages.some(message => message.type === 'drained'));
        assert.equal(messages.some(message => message.type === 'economy_route_result' && message.payload.requestId === 4), false,
            'handoff cancels route scratch and suppresses publication');
        assert.equal(messages.some(message => message.type === 'fault'), false, 'small valid route envelopes respect worker isolation');
    } finally { await worker.terminate(); }
    console.log('Prepared economic routes: cooperative table, strict bounds, real worker parity, coalescing, replacement and fence passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Config.coldHonestTravel = saved; });
