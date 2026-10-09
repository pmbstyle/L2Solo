'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Decisions = require('../src/GameServer/Bot/Population/ColdEconomyDecision');

async function runWorker(state, predicate) {
    const epoch = `economy-publication-${state.characterId}`, received = [];
    const worker = new Worker(path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
        { workerData: { workerEpoch: epoch }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let failure, exited = false;
    worker.on('error', error => { failure = error; });
    worker.on('message', message => received.push(message));
    const joined = new Promise(resolve => worker.once('exit', code => { exited = true; resolve(code); }));
    async function until(test) {
        const deadline = Date.now() + 20000;
        while (!received.some(test)) {
            if (failure) throw failure;
            const fault = received.find(message => message.type === 'fault');
            if (fault) throw Error(JSON.stringify(fault.payload));
            if (exited || Date.now() >= deadline) throw Error('native economy publication timed out');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return received.find(test);
    }
    function send(type, payload, msgId) {
        const message = Protocol.envelope(type, epoch, payload, msgId);
        assert.equal(Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch }).ok, true);
        worker.postMessage(message);
    }
    try {
        const loaded = await until(message => message.type === 'ready' && message.payload.phase === 'loaded');
        assert.equal(loaded.payload.forbiddenDependencies, 0);
        send('catalog_page', { catalog: 'spots', rows: [], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('table_page', { tables: ['board', 'market'].map(name =>
            ({ name, from: null, to: 0, full: true, rows: [], removed: [] })) });
        send('init', { config: { loopIntervalMs: 20, maxInFlight: 1, maxBatch: 1 } }, 'init');
        await until(message => message.type === 'ready' && message.msgId === 'init');
        send('snapshot_page', { rows: [{ state, context: {} }], initial: true, done: true });
        const result = await until(predicate);
        assert(!received.some(message => message.type === 'fault'));
        send('shutdown', {}, 'shutdown');
        await until(message => message.type === 'drained' && message.msgId === 'shutdown');
        assert.equal(await joined, 0);
        return result;
    } finally { if (!exited) await worker.terminate(); }
}

(async () => {
    const now = Date.now();
    const state = { characterId: 765411, name: 'PublicationOwner', accountName: 'bot_publication',
        phase: 'hot', activity: 'hunting', level: 40, adena: 100000, exp: 0, sp: 1000,
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, currentRegion: 'Giran',
        inventory: {}, stats: { classId: 0, clanId: 9, generatedCold: true },
        timing: { nextResolveAt: now + 60000, lastResolvedAt: now - 60000 }, updatedAt: now,
        simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const hot = await runWorker(state, message => message.type === 'ready' && message.payload.phase === 'economy_decided');
    const decision = Decisions.compact(hot.payload.economyDecision);
    assert.equal(decision.clan, null);
    assert.equal(decision.workshop.known, true);
    assert.equal(decision.key, Decisions.stateKey(state));

    const instances = Array.from({ length: 2075 }, (_, index) => ({ id: 900000 + index,
        selfId: 952, amount: 1, equipped: false, slot: 0, enchant: 0 }));
    const large = { ...state, characterId: 765412, phase: 'cold', activity: 'shopping',
        stats: { classId: 0, generatedCold: true, money: [1000, .001, 0, 0] },
        timing: { ...state.timing, nextResolveAt: Date.now() - 1 },
        inventory: { 952: { selfId: 952, amount: instances.length, equipped: false, stackable: false, instances } } };
    const command = await runWorker(large, message => message.type === 'command_request');
    const request = command.payload.requests[0];
    assert(Protocol.sameCommandCheckpoint(large, request.commandCheckpoint));
    assert.deepEqual(request.state.inventory, large.inventory, 'the complete admitted bag crosses unchanged');
    assert(request.precomputedResult && request.precomputedPlan.statsPacket && request.precomputedPlan.economyDecision,
        'native combat and economy results remain in the command');
    assert.equal(request.precomputedPlan.plannedState, undefined, 'the unused duplicate state is omitted on overflow');
    assert(Protocol.byteLength(command) <= Protocol.MAX_MESSAGE_BYTES);
    const expanded = { ...command, payload: { requests: [{ ...request,
        precomputedPlan: { ...request.precomputedPlan, plannedState: large } }] } };
    assert(Protocol.byteLength(expanded) > Protocol.MAX_MESSAGE_BYTES, 'this actual bag reproduces the old overflow');
    assert.equal(Protocol.omitPlannedStates(expanded), true);
    assert.equal(Protocol.validateEnvelope(expanded, 'worker').ok, true);
    assert.equal(Protocol.omitPlannedStates(expanded), false);
    const stillTooLarge = { ...command, payload: { requests: [{ ...request,
        state: { ...large, inventory: { ...large.inventory, secondBag: large.inventory[952] } } }] } };
    assert.equal(Protocol.omitPlannedStates(stillTooLarge), false);
    assert.equal(Protocol.validateEnvelope(stillTooLarge, 'worker').reason, 'message_too_large',
        'required source data never bypasses the fixed transport cap');
    console.log('PASS native hot clan publication and oversized lifecycle command', JSON.stringify({
        expandedBytes: Protocol.byteLength({ ...command, payload: { requests: [{ ...request,
            precomputedPlan: { ...request.precomputedPlan, plannedState: large } }] } }),
        commandBytes: Protocol.byteLength(command), instances: instances.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
