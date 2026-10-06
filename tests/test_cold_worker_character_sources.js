'use strict';
const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');
const root = path.resolve(__dirname, '..');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const workerPath = root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js';
const epoch = 'character-source-native';
const observer = String.raw`
const assert = require('assert');
module.exports.inspectSources = async name => {
    const Runtime = require('../../World/CharacterLocationRuntime'), Cache = require('./LifeStateCache');
    const current = kernel.states.get(1), original = current?.state;
    if (name === 'positive') {
        let refused = false; try { new Cache({ locationIndex: Runtime.index }); } catch (e) { refused = /already_owned/.test(e.message); }
        const projected = await LifeStateProjector.prepareResolve(original, { patch: { activity: 'crafting' },
            materialize: { exp: 0, sp: 0, adena: 0, items: [{ selfId: 1864, amount: 19 }] }, debug: {}, events: [],
            nextResolveAt: original.timing.nextResolveAt }, { persist: false, projectClassProgression: true, timestamp: original.updatedAt + 1 });
        assert.strictEqual(projected.inventory['1864'].amount, 31); assert.strictEqual(original.inventory['1864'].amount, 12);
        assert(refused); assert.strictEqual(forbiddenLoaded.length, 0);
        assert(!Object.keys(require.cache).some(file => /\/(GeodataEngine|ActivationPlacement)\.js$/.test(file)));
        return { original: true, ownerRefused: refused, inventory: [12, 31], forbidden: forbiddenLoaded.length };
    }
    if (name === 'guards') {
        assert.strictEqual(await LifeStateProjector.prepareResolve(null, {}, {}), null);
        let reads = 0;
        const needingProfile = { ...original, stats: { ...original.stats, classProgressionLevel: 0 },
            get exp() { reads++; return 0; } };
        for (const options of [{}, { persist: true, projectClassProgression: true }, { persist: false },
            { persist: false, projectClassProgression: false }]) {
            await assert.rejects(LifeStateProjector.prepareResolve(needingProfile, { patch: {}, materialize: {}, debug: {} }, options),
                /worker_projector_projection_required/);
        }
        assert.strictEqual(reads, 0, 'mode rejected before progression/profile facts or SQL');
        await assert.rejects(LifeStateProjector.init(), /worker_projector/);
        assert.throws(() => LifeStateProjector.refreshOccupancy(original), /worker_projector/);
        return { rejectedBeforeReads: true };
    }
    if (name === 'publication') {
        assert.strictEqual(Runtime.index.getSource(1, 'state').source, original);
        assert.strictEqual(LifeStateProjector.cachedState(1), original);
        assert.strictEqual(Object.getOwnPropertyDescriptor(Map.prototype,'size').get.call(kernel.states), 0);
        assert.strictEqual(Runtime.index.sourceSize('state'), kernel.states.size);
        assert.deepStrictEqual(LifeStateProjector.allStates(500), [], 'Main recent effects remain unprepared in Worker');
        assert.strictEqual(LifeStateProjector.occupancyIndex().places.size, 0);
        const role = Runtime.workerProjectorRole(), cap = LifeStateProjector.passiveWorkerStateSources(role);
        const Sources = require('../../World/CharacterStateSources'), Index = require('../../World/CharacterLocationIndex');
        assert.throws(() => Sources.registerCacheOwner(Runtime.index, {}, { role, isCurrent: () => true }), /already_owned/);
        assert.throws(() => Sources.issueNativeGrant(Runtime.index, {}, role, epoch), /passive_grant/);
        assert.throws(() => Sources.issueNativeGrant(Runtime.index, {}, {}, 'foreign'), /passive_grant/);
        assert.throws(() => new Cache({ locationIndex: Runtime.index, workerProjectorRole: {} }), /worker_projector/);
        assert.throws(() => new Cache({ locationIndex: new Index({ legacyStateCache: true }), workerProjectorRole: role }), /worker_projector/);
        assert.throws(() => Sources.attachKernel({ ...cap }), /state_sources/);
        assert.strictEqual(LifeStateProjector.passiveWorkerStateSources(role), cap);
        assert.strictEqual(Runtime.beginWorkerProjectorRole(epoch), role);
        for (const fake of [{}, { ...role }, null]) assert.throws(() => LifeStateProjector.passiveWorkerStateSources(fake), /worker_projector/);
        assert.throws(() => Runtime.beginWorkerProjectorRole('foreign'), /worker_projector/);
        assert.throws(() => Runtime.bindWorld({ sessions: [] }), /worker_projector/);
        const before = Runtime.index.getSource(1, 'state');
        assert.throws(() => new ColdSimulationKernel({ resolveSolo: () => ({}), stateSources: cap }), /already_attached/);
        assert.strictEqual(Runtime.index.getSource(1, 'state'), before);
        const count = LifeStateProjector.stateRevision();
        const row = { characterId: 1, name: 'SourceNative', phase: 'cold', activity: 'crafting', level: 1,
            inventoryJson: '{}', statsJson: '{}', updatedAt: original.updatedAt + 1 };
        assert.throws(() => LifeStateProjector.acceptLifecycleRow(row), /worker_passive_state_write/);
        assert.strictEqual(Runtime.index.getSource(1, 'state'), before);
        assert.strictEqual(LifeStateProjector.stateRevision(), count);
        module.exports.oldPacket = current;
        return { backing: 0, sharedOriginal: true, ownerStable: true };
    }
    if (name === 'replacement') {
        assert.strictEqual(Runtime.index.getSource(1, 'state').source, original);
        assert.strictEqual(original.inventory['1864'].amount, 31);
        assert.strictEqual(module.exports.oldPacket.state.inventory['1864'].amount, 12);
        assert.notStrictEqual(original, module.exports.oldPacket.state);
        assert.strictEqual(Runtime.index.removeSource(1,'state',module.exports.oldPacket.state), false);
        const needsTree = { ...original, stats: { ...original.stats, classProgressionLevel: 0 } };
        const projected = await LifeStateProjector.prepareResolve(needsTree, { patch: {}, materialize: {}, debug: {} },
            { persist: false, projectClassProgression: true, timestamp: original.updatedAt + 1 });
        assert(projected.stats.classProgressionLevel >= 1); assert(projected.stats.coldCombat);
        assert.strictEqual(Runtime.index.getSource(1,'state').source, original);
        assert(!Object.keys(require.cache).some(file => /\/(GeodataEngine|ActivationPlacement)\.js$/.test(file)));
        return { oldPacketPreserved: true, pureTreeProjected: true };
    }
    if (name === 'removed') {
        assert.strictEqual(Runtime.index.getSource(1,'state'), null); assert.strictEqual(LifeStateProjector.cachedState(1), null);
        assert.strictEqual(Runtime.index.sourceSize('state'), kernel.states.size);
        return { fenced: true };
    }
    throw Error('unknown source oracle');
};`;
const wrapper = String.raw`
const fs = require('fs'), path = require('path'), Module = require('module');
const { parentPort, workerData } = require('worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath,'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.sourceOracle) return;
    loaded.exports.inspectSources(message.sourceOracle).then(value => parentPort.postMessage({ oracleId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ oracleId: message.msgId, error: error.stack }));
});`;

(async () => {
    const worker = new Worker(wrapper, { eval: true, workerData: { workerPath, observer, workerEpoch: epoch },
        resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const messages = []; let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    async function wait(predicate) {
        const deadline = Date.now() + 15000;
        while (!messages.some(predicate)) {
            if (fault) throw fault;
            if (Date.now() > deadline) throw Error('bounded native source reply timeout');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return messages.find(predicate);
    }
    let sequence = 0;
    async function oracle(name) {
        const msgId = `oracle-${++sequence}`;
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, msgId), sourceOracle: name });
        const message = await wait(reply => reply.oracleId === msgId);
        if (message.error) throw Error(message.error);
        console.log(name, JSON.stringify(message.value));
    }
    const born = Date.now();
    const original = { characterId: 1, name: 'SourceNative', level: 1, exp: 0, sp: 0, adena: 0,
        phase: 'cold', activity: 'crafting', loc: { locX: 1, locY: 2, locZ: 3 }, vitals: { hp: 100, mp: 50 },
        timing: { activityStartedAt: born, nextResolveAt: born + 3600000, lastResolvedAt: born, lastHotAt: 0 },
        simulation: { ownerId: 'legacy_main', revision: 2, leaseId: null, leaseUntil: 0 }, updatedAt: born,
        inventory: { '1864': { selfId: 1864, amount: 12 } }, stats: { classId: 0,
            classProgressionLevel: 1, classProgressionClassId: 0, craftShop: { town: 'Giran', loc: { locX: 1, locY: 2, locZ: 3 } } } };
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        worker.postMessage(Protocol.envelope('init', epoch, { config: { pvpAggression: 0 } }, 'init'));
        await wait(message => message.type === 'ready' && message.payload.phase === 'running');
        worker.postMessage(Protocol.envelope('pause', epoch, {}, 'pause'));
        worker.postMessage(Protocol.envelope('snapshot_page', epoch, { rows: [{ state: original, context: { route: null } }],
            initial: true, done: true, ack: true }, 'initial'));
        await wait(message => message.type === 'ready' && message.msgId === 'initial');
        await oracle('positive'); await oracle('guards'); await oracle('publication');
        const replacement = { ...original, inventory: { '1864': { selfId: 1864, amount: 31 } }, updatedAt: born + 1 };
        worker.postMessage(Protocol.envelope('snapshot_page', epoch, { rows: [{ state: replacement, context: { route: null, fresh: true } }], ack: true }, 'replace'));
        await wait(message => message.type === 'ready' && message.msgId === 'replace'); await oracle('replacement');
        worker.postMessage(Protocol.envelope('fence', epoch, { characterId: 1 }, 'fence'));
        await wait(message => message.type === 'fence_ack' && message.msgId === 'fence'); await oracle('removed');
        worker.postMessage(Protocol.envelope('shutdown', epoch, {}, 'shutdown'));
        await wait(message => message.type === 'drained');
    } finally { await worker.terminate(); }

    const fallback = new Worker(workerPath); let problem;
    const received = []; fallback.on('message', message => received.push(message)); fallback.on('error', error => { problem = error; });
    async function fallbackWait(type, phase) {
        const deadline = Date.now() + 15000;
        while (!received.some(message => message.type === type && (!phase || message.payload.phase === phase))) {
            if (problem) throw problem;
            if (Date.now() > deadline) throw Error('bounded default epoch timeout');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const result = received.find(message => message.type === type && (!phase || message.payload.phase === phase));
        assert.strictEqual(result.workerEpoch, 'cold-worker'); return result;
    }
    try {
        assert.strictEqual((await fallbackWait('ready', 'loaded')).payload.forbiddenDependencies, 0);
        fallback.postMessage(Protocol.envelope('init', 'cold-worker', {}, 'init'));
        await fallbackWait('ready', 'running');
        fallback.postMessage(Protocol.envelope('shutdown', 'cold-worker', {}, 'shutdown')); await fallbackWait('drained');
    } finally { await fallback.terminate(); }
    console.log('Actual cold Worker common-source/native role/projection/lifetime/default-epoch checks passed');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
