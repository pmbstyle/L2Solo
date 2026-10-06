'use strict';

// Genuine helper-only OS Worker: actor read quarantine and backing identity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Worker, isMainThread, workerData, parentPort, threadId } = require('node:worker_threads');
const gameRoot = path.resolve(isMainThread
    ? process.env.N53_GAME_ROOT || path.join(__dirname, '..') : workerData.sourceRoot);
const point = Object.freeze({ locX: 0, locY: 0, locZ: 0 });
const UNKNOWN = 'CHARACTER_ACTOR_VIEW_UNKNOWN';
const moduleAt = name => require(path.join(gameRoot, 'src/GameServer', name));
const blocked = filename => /[/\\]src[/\\](Global|Database)\.js$/.test(filename)
    || /[/\\]World[/\\]World\.js$/.test(filename) || /[/\\]ColdSimulationWorker\.js$/.test(filename);

function thrown(call) {
    let didThrow = false, value;
    try { call(); } catch (error) { didThrow = true; value = error; }
    return { didThrow, value };
}
function unknown(call) {
    const result = thrown(call);
    assert.equal(result.didThrow, true);
    assert(result.value instanceof TypeError);
    assert.equal(result.value.code, UNKNOWN);
}
function refused(call) {
    const result = thrown(call);
    assert.equal(result.didThrow, true);
    assert(result.value instanceof TypeError);
}
function exactThrow(call, original) {
    const result = thrown(call);
    assert.equal(result.didThrow, true);
    assert.equal(result.value, original);
}
function installLoadObserver() {
    const original = Module._load, requests = [];
    Module._load = function(request, parent, ...rest) {
        const filename = Module._resolveFilename(request, parent);
        requests.push(filename);
        if (blocked(filename)) throw new Error('forbidden_helper_game_import:' + filename);
        return Reflect.apply(original, this, [request, parent, ...rest]);
    };
    return { requests, restore() { Module._load = original; } };
}
function noGameImports() {
    const loaded = Object.keys(require.cache);
    assert.deepEqual(loaded.filter(blocked), []);
    assert.equal(global.invoke, undefined); assert.equal(global.options, undefined);
    assert.equal(global.utils, undefined);
    return loaded.filter(filename => filename.startsWith(gameRoot + path.sep));
}
function actorReads(index) {
    return [
        ['get', () => index.get(1), null],
        ['getSource', () => index.getSource(1, 'actor'), null],
        ['sourceSize', () => index.sourceSize('actor'), 0],
        ['sourceKeys', () => index.sourceKeys('actor'), 'iterator'],
        ['sourceValues', () => index.sourceValues('actor'), 'iterator'],
        ['sourceEntries', () => index.sourceEntries('actor'), 'iterator'],
        ['near', () => index.near(point, 0), 'array'],
        ['nearSources', () => index.nearSources(point, 0, { view: 'actor' }), 'array'],
        ['nearFacet', () => index.nearFacet(point, 0), 'array'],
        ['inSpot', () => index.inSpot('fixture-spot'), 'array'],
        ['inSpotSources', () => index.inSpotSources('fixture-spot', { view: 'actor' }), 'array'],
        ['groupSources', () => index.groupSources('fixture-group'), 'iterator']
    ];
}
function everyUnknown(index) {
    const calls = actorReads(index); assert.equal(calls.length, 12);
    for (const [, read] of calls) unknown(read); // Admission includes iterator CREATION.
}
function knownEmpty(index) {
    for (const [, read, type] of actorReads(index)) {
        const value = read();
        if (type === 'iterator') assert.deepEqual(Array.from(value), []);
        else if (type === 'array') assert.deepEqual(value, []);
        else assert.equal(value, type);
    }
}
function facadeCalls(facade) {
    return [() => facade.get(1), () => facade.has(1), () => facade.size,
        () => facade.keys(), () => facade.values(), () => facade.entries(),
        () => facade[Symbol.iterator](), () => facade.forEach(() => null)];
}
function snapshotUnknown(index) {
    return actorReads(index).map(([name, call]) => {
        const result = thrown(call);
        return { name, didThrow: result.didThrow, code: result.value?.code };
    });
}
function assertUnknownSnapshot(snapshot) {
    assert.equal(snapshot.length, 12);
    assert.equal(snapshot.every(item => item.didThrow && item.code === UNKNOWN), true);
}
function equalRefs(actual, expected) {
    assert.equal(actual.length, expected.length);
    assert.equal(new Set(actual).size, expected.length);
    for (const value of expected) assert(actual.includes(value));
}

// Delegate the exact native Map iterator and result; no fabricated step/index.
function afterNativeStep(map, method, action, call) {
    const previous = Object.getOwnPropertyDescriptor(map, method), delegate = map[method];
    const observations = [];
    let armed = true;
    Object.defineProperty(map, method, { configurable: true, value: function(...args) {
        const original = Reflect.apply(delegate, this, args), next = original.next;
        Object.defineProperty(original, 'next', { configurable: true, value: function(...nextArgs) {
            const item = Reflect.apply(next, this, nextArgs);
            if (armed) {
                armed = false; observations.push({ done: item.done, value: item.value });
                action();
            }
            return item;
        } });
        return original;
    } });
    try { call(); } finally {
        if (previous) Object.defineProperty(map, method, previous);
        else delete map[method];
    }
    assert.equal(observations.length, 1);
    return observations[0];
}
function duringNativeIteratorCreation(map, method, action, call) {
    const previous = Object.getOwnPropertyDescriptor(map, method), delegate = map[method];
    let calls = 0;
    Object.defineProperty(map, method, { configurable: true, value: function(...args) {
        const original = Reflect.apply(delegate, this, args);
        if (calls++ === 0) action();
        return original;
    } });
    try { call(); } finally {
        if (previous) Object.defineProperty(map, method, previous);
        else delete map[method];
    }
    assert(calls > 0);
}

function workerMain() {
    assert.equal(isMainThread, false); assert(threadId > 0);
    assert.equal(process.env.L2NODE_SHARED_CONFIG_FILE, undefined);
    assert.equal(process.env.L2NODE_CONFIG_FILE, workerData.generated.config);
    const observer = installLoadObserver(), groups = [], progressLog = [];
    try {
        const Runtime = moduleAt('World/CharacterLocationRuntime');
        const Index = moduleAt('World/CharacterLocationIndex');
        const TableMirror = moduleAt('Bot/Population/TableMirror');
        const Sources = moduleAt('World/CharacterActorSources');
        const index = Runtime.index;
        assert(index instanceof Index); everyUnknown(index);
        const stateSource = { characterId: 1, phase: 'cold', loc: point };
        const stateRecord = { id: 1, source: stateSource, phase: 'cold', spotId: 'fixture-state', loc: () => point };
        index.setSource(1, 'state', stateRecord);
        const stateIterator = index.sourceKeys('state');
        const conserveState = () => {
            assert.equal(index.getSource(1, 'state'), stateRecord);
            assert.equal(index.getSource(1, 'state').source, stateSource);
            assert.equal(index.sourceSize('state'), 1);
            assert.deepEqual(index.nearSources(point, 0, { view: 'state' }), [stateRecord]);
            assert.deepEqual(index.inSpotSources('fixture-state', { view: 'state' }), [stateRecord]);
        };
        const role = Runtime.beginWorkerProjectorRole(workerData.workerEpoch);
        assert.equal(Runtime.workerProjectorRole(), role);
        assert.equal(Runtime.isWorkerProjectorRole(role, index), true);
        assert.equal(Runtime.nativeActorMirror(), null);
        // Do NOT poison this child with a sticky pre-Mirror Sources.native().
        const tables = new TableMirror({ actorProjectorRole: role });
        const consent = TableMirror.nativeActorMirrorOwner(tables);
        assert.equal(Runtime.nativeActorMirror(), tables);
        assert.equal(consent.mirror, tables); assert.equal(consent.index, index);
        assert.equal(consent.role, role); assert.equal(consent.epoch, workerData.workerEpoch);
        assert.equal(tables.ready('actors'), false); unknown(() => tables.rows('actors'));
        refused(() => tables.apply([{ name: 'actors', from: null, to: 1, full: true, last: 1,
            rows: [], removed: [], attachmentId: 1, copyId: 1, transferId: 1, pageIndex: 0, worldGeneration: 1 }]));
        assert.equal(tables.tables.has('actors'), false);
        everyUnknown(index); conserveState();
        const native = Sources.native();
        assert.equal(native.index, index);
        let store;
        const owner = tables.attachStore('actors', (actualOwner, descriptor) => {
            store = native.createStore(actualOwner, descriptor); return store;
        });
        const binding = TableMirror.actorStoreOwner(owner), descriptor = binding.descriptor;
        const port = Runtime.actorProducerReads();
        assert.equal(binding.mirror, tables); assert.equal(Sources.actorStoreIndex(owner), index);
        assert.equal(Sources.actorStoreMatches(owner, store), true);
        assert.equal(Sources.actorStoreMatches(owner, Object.create(store)), false);
        assert.equal(Runtime.actorProducerReads(), port);
        everyUnknown(index); conserveState();
        groups.push('real_early_all12_unknown_and_exact_native_association');

        let version = 0, copyId = 0, transferId = 0, publication = 0;
        const row = (id, x) => {
            publication++;
            return Object.freeze({ id, worldGeneration: 1, sourceGeneration: publication,
                publication, order: id, axes: Object.freeze({
                    x: Object.freeze({ tag: 'number', value: x }),
                    y: Object.freeze({ tag: 'number', value: 0 }),
                    z: Object.freeze({ tag: 'number', value: 0 }) }) });
        };
        const head = (rows, last = 1, sameVersion = false) => {
            if (!sameVersion) version++;
            copyId++; transferId++;
            return { name: 'actors', from: null, to: version, full: true, last,
                rows: rows.map(value => [value.id, value]), removed: [], attachmentId: 1,
                copyId, transferId, pageIndex: 0, worldGeneration: 1 };
        };
        const clean = () => {
            for (let count = 0; !tables.ready('actors') && count < 8; count++) {
                everyUnknown(index); conserveState();
                const progress = tables.cleanupStore('actors', 1);
                assert(progress.inspected <= 1); progressLog.push(progress);
                if (!progress.done) everyUnknown(index);
            }
            assert.equal(tables.ready('actors'), true);
        };
        let latestPiece;
        const full = (rows, sameVersion = false) => {
            const piece = head(rows, 1, sameVersion);
            assert.deepEqual(tables.apply([piece]), []); latestPiece = piece; clean();
            return piece;
        };
        full([]); knownEmpty(index);
        const emptyReceipt = TableMirror.actorStoreRead(owner);
        assert.equal(TableMirror.actorStoreReadCurrent(owner, emptyReceipt), true);
        assert.equal(TableMirror.actorStoreReadCurrent(owner, { ...emptyReceipt }), false);
        const emptyDone = index.sourceKeys('actor');
        assert.deepEqual(emptyDone.next(), { value: undefined, done: true });
        const first = row(1, -0), second = row(2, 1), expected = [first, second];
        full(expected);
        unknown(() => emptyDone.next());
        const currentRefs = () => {
            const one = index.get(1), two = index.getSource(2, 'actor');
            assert.equal(one, index.getSource(1, 'actor'));
            assert.equal(one.source, first); assert.equal(two.source, second);
            assert.equal(store.get(1), first); assert.equal(store.get(2), second);
            assert.equal(Object.is(one.source.axes.x.value, -0), true);
            assert.equal(index.sourceSize('actor'), 2);
            assert.deepEqual(Array.from(index.sourceKeys('actor')), [1, 2]);
            assert.deepEqual(Array.from(index.sourceValues('actor')), [one, two]);
            assert.deepEqual(Array.from(index.sourceEntries('actor')), [[1, one], [2, two]]);
            equalRefs(index.nearFacet(point, 1).map(record => record.source), expected);
            // Passive actor layer publishes rawXY only, not generic/spot/party facts.
            assert.deepEqual(index.near(point, 1), []);
            assert.deepEqual(index.nearSources(point, 1, { view: 'actor' }), []);
            assert.deepEqual(index.inSpot('fixture-spot'), []);
            assert.deepEqual(index.inSpotSources('fixture-spot', { view: 'actor' }), []);
            assert.deepEqual(Array.from(index.groupSources('fixture-group')), []);
            conserveState();
        };
        currentRefs();
        groups.push('known_empty_and_all12_current_original_dto_rawXY_state');

        const facade = tables.rows('actors');
        assert.equal(facade.get(1), first); assert.equal(facade.has(1), true);
        assert.equal(facade.size, 2);
        assert.deepEqual(Array.from(facade.keys()), [1, 2]);
        assert.deepEqual(Array.from(facade.values()), expected);
        assert.deepEqual(Array.from(facade.entries()), [[1, first], [2, second]]);
        assert.deepEqual(Array.from(facade), [[1, first], [2, second]]);
        const thisArg = {}, visits = [];
        const callback = function(value, id, actualFacade) { visits.push([this, value, id, actualFacade]); return false; };
        callback.call = () => { throw new Error('own_call_must_not_run'); };
        facade.forEach(callback, thisArg);
        assert.deepEqual(visits, [[thisArg, first, 1, facade], [thisArg, second, 2, facade]]);
        const heldFactories = [() => index.sourceKeys('actor'), () => index.sourceValues('actor'),
            () => index.sourceEntries('actor'), () => index.groupSources('fixture-group'),
            () => facade.keys(), () => facade.values(), () => facade.entries(), () => facade[Symbol.iterator]()];
        const held = heldFactories.map(create => create());
        for (const iterator of held) iterator.next(); // Includes an already-done group iterator.
        const oldReceipt = TableMirror.actorStoreRead(owner), oldVersion = tables.version('actors');
        full(expected, true); assert.equal(tables.version('actors'), oldVersion);
        assert.equal(TableMirror.actorStoreReadCurrent(owner, oldReceipt), false);
        for (const iterator of held) unknown(() => iterator.next());
        currentRefs();
        groups.push('optional_facade_originals_forEach_and_held_each_next_done');

        for (const [method, create] of [['keys', () => index.sourceKeys('actor')],
            ['values', () => index.sourceValues('actor')], ['entries', () => index.sourceEntries('actor')],
            ['entries', () => facade.entries()]]) {
            duringNativeIteratorCreation(index.sourceViews.actor, method, () => full(expected, true), () => unknown(create));
            const item = afterNativeStep(index.sourceViews.actor, method, () => full(expected, true), () => {
                const iterator = create(); unknown(() => iterator.next());
            });
            assert.equal(item.done, false); currentRefs();
        }
        full([]);
        const doneItem = afterNativeStep(index.sourceViews.actor, 'keys', () => full([], true), () => {
            const iterator = index.sourceKeys('actor'); unknown(() => iterator.next());
        });
        assert.equal(doneItem.done, true);
        const doneHeld = heldFactories.map(create => create());
        for (const iterator of doneHeld) assert.deepEqual(iterator.next(), { value: undefined, done: true });
        full([], true);
        for (const iterator of doneHeld) unknown(() => iterator.next());
        full(expected); currentRefs();
        groups.push('original_native_steps_after_delegate_and_done_invalidation');

        for (const query of [(loc) => index.near(loc, 0),
            (loc) => index.nearSources(loc, 0, { view: 'actor' }), (loc) => index.nearFacet(loc, 0)]) {
            let laterAxes = 0;
            const origin = { get locX() { full(expected, true); return 0; },
                get locY() { laterAxes++; return 0; }, get locZ() { laterAxes++; return 0; } };
            unknown(() => query(origin)); assert.equal(laterAxes, 0); currentRefs();
            unknown(() => query(() => { full(expected, true); return point; })); currentRefs();
            for (const original of [undefined, null, 0]) {
                laterAxes = 0;
                const throwingOrigin = { get locX() { full(expected, true); throw original; },
                    get locY() { laterAxes++; return 0; }, get locZ() { laterAxes++; return 0; } };
                exactThrow(() => query(throwingOrigin), original);
                assert.equal(laterAxes, 0); currentRefs();
            }
        }
        // Trigger on the second X property read: V2 also guards bounds steps.
        let xReads = 0, yReads = 0;
        const boundsOrigin = { get locX() { xReads++; if (xReads === 2) full(expected, true); return 0; },
            get locY() { yReads++; return 0; }, locZ: 0 };
        unknown(() => index.nearSources(boundsOrigin, 0, { view: 'actor' }));
        assert.equal(xReads, 2); assert.equal(yReads, 1); currentRefs();
        groups.push('provider_axis_steps_ready_to_ready_and_original_falsy_throw');

        let filtered = 0;
        assert.deepEqual(index.nearFacet(point, 1, { accept() { filtered++; return false; } }), []);
        assert.equal(filtered, 2);
        filtered = 0;
        unknown(() => index.nearFacet(point, 1, { accept() { filtered++; full(expected, true); return false; } }));
        assert.equal(filtered, 1); currentRefs();
        let callbacks = 0;
        unknown(() => facade.forEach(() => { callbacks++; full(expected, true); return false; }));
        assert.equal(callbacks, 1); currentRefs();
        for (const original of [undefined, null, 0]) {
            exactThrow(() => index.nearFacet(point, 1, { accept() { full(expected, true); throw original; } }), original);
            currentRefs();
            exactThrow(() => facade.forEach(() => { full(expected, true); throw original; }), original);
            currentRefs();
        }
        groups.push('false_filter_forEach_reentry_and_exact_undefined_null_zero');

        const prefixPiece = () => ({ name: 'fixture-ordinary', full: true, from: null, to: 1,
            last: 1, rows: [[1, { original: true }]], removed: [] });
        let prefixObservations = [];
        tables.watch('fixture-ordinary', { reset() {}, remove() {}, put() {
            prefixObservations.push({ reads: snapshotUnknown(index), ready: tables.ready('actors') });
        } });
        const prefixReceipt = TableMirror.actorStoreRead(owner), prefixActor = head(expected);
        assert.deepEqual(tables.apply([prefixPiece(), prefixActor]), []); latestPiece = prefixActor; clean();
        assert.equal(prefixObservations.length, 1);
        assertUnknownSnapshot(prefixObservations[0].reads); assert.equal(prefixObservations[0].ready, false);
        assert.equal(TableMirror.actorStoreReadCurrent(owner, prefixReceipt), false); currentRefs();
        prefixObservations = [];
        tables.watch('fixture-ordinary', { reset() {}, remove() {}, put() {
            const before = snapshotUnknown(index), nested = head(expected, 1, true);
            const result = tables.apply([nested]);
            prefixObservations.push({ before, result, after: snapshotUnknown(index), ready: tables.ready('actors') });
        } });
        const outerActor = head(expected);
        assert.deepEqual(tables.apply([prefixPiece(), outerActor]), ['actors']);
        assert.equal(prefixObservations.length, 1); assert.deepEqual(prefixObservations[0].result, []);
        assertUnknownSnapshot(prefixObservations[0].before); assertUnknownSnapshot(prefixObservations[0].after);
        assert.equal(prefixObservations[0].ready, false); everyUnknown(index);
        full(expected); currentRefs();
        for (const original of [undefined, null, 0]) {
            const beforeChain = descriptor.chain, beforeReceipt = TableMirror.actorStoreRead(owner);
            let prefixUnknown;
            tables.watch('fixture-ordinary', { reset() {}, remove() {}, put() {
                prefixUnknown = snapshotUnknown(index); throw original;
            } });
            exactThrow(() => tables.apply([prefixPiece(), head(expected)]), original);
            assertUnknownSnapshot(prefixUnknown); assert.equal(descriptor.chain, beforeChain);
            assert.equal(TableMirror.actorStoreReadCurrent(owner, beforeReceipt), false);
            everyUnknown(index); full(expected); currentRefs();
        }
        groups.push('whole_prefix_nested_depth_and_original_prefix_falsy_error');

        const replay = latestPiece, beforeReplayChain = descriptor.chain;
        const beforeReplay = TableMirror.actorStoreRead(owner), beforeOccurrence = descriptor.readOccurrence;
        assert.deepEqual(tables.apply([replay]), ['actors']);
        assert.equal(descriptor.chain, beforeReplayChain);
        assert.notEqual(descriptor.readOccurrence, beforeOccurrence);
        assert.equal(TableMirror.actorStoreReadCurrent(owner, beforeReplay), false);
        everyUnknown(index); full(expected, true); currentRefs();
        const malformed = { ...head(expected), last: 3 }, beforeMalformed = TableMirror.actorStoreRead(owner);
        refused(() => tables.apply([malformed])); everyUnknown(index);
        assert.equal(TableMirror.actorStoreReadCurrent(owner, beforeMalformed), false);
        full(expected); currentRefs();
        groups.push('rejected_same_chain_malformed_entry_and_real_same_version_recovery');

        const partial = head([], 0);
        assert.deepEqual(tables.apply([partial]), []); everyUnknown(index);
        assert.equal(tables.summary().actors.rows, null); assert.equal(tables.summary().actors.ready, false);
        for (const call of facadeCalls(facade)) unknown(call);
        assert.equal(store.get(1), first); assert.equal(port.getSource(1, 'actor').source, first);
        assert.equal(store.entries().next().value[1], first);
        assert.deepEqual(tables.cleanupStore('actors', 1), { inspected: 0, done: false });
        const terminal = { ...partial, full: false, from: partial.to, last: 1, pageIndex: 1 };
        assert.deepEqual(tables.apply([terminal]), []); everyUnknown(index);
        const firstCleanup = tables.cleanupStore('actors', 1);
        assert.deepEqual(firstCleanup, { inspected: 1, done: false }); everyUnknown(index); conserveState();
        const secondCleanup = tables.cleanupStore('actors', 1);
        assert.deepEqual(secondCleanup, { inspected: 1, done: true }); knownEmpty(index); conserveState();
        progressLog.push(firstCleanup, secondCleanup);
        full(expected); currentRefs();
        groups.push('genuine_bounded_private_cleanup_while_all_public_aliases_unknown');

        assert.equal(Sources.actorStoreIndex({ ...owner }), null);
        unknown(() => TableMirror.actorStoreRead({ ...owner }));
        refused(() => native.createStore({ ...owner }, descriptor));
        refused(() => Runtime.attachActorReadOwner({ ...owner }));
        refused(() => new TableMirror({ actorProjectorRole: { ...role } }));
        refused(() => new TableMirror({ actorProjectorRole: role }));
        assert.equal(Runtime.nativeActorMirror(), tables); currentRefs();
        const pureTables = new TableMirror(), pure = Sources.standalone();
        let pureStore, wrongMirrorResult;
        const pureOwner = pureTables.attachStore('actors', (actualOwner, actualDescriptor) => {
            wrongMirrorResult = thrown(() => native.createStore(actualOwner, actualDescriptor));
            pureStore = pure.createStore(actualOwner, actualDescriptor); return pureStore;
        });
        assert.equal(wrongMirrorResult.didThrow, true); assert(wrongMirrorResult.value instanceof TypeError);
        assert.equal(Sources.actorStoreIndex(pureOwner), pure.index); assert.notEqual(pure.index, index);
        assert.equal(TableMirror.nativeActorMirrorOwner(pureTables), null);
        refused(() => Runtime.attachActorReadOwner(pureOwner));
        refused(() => Sources.native()); currentRefs();
        refused(() => port.getSource(1, 'state')); refused(() => port.sourceSize('state'));
        refused(() => port.sourceEntries('state'));
        const swapMirror = new TableMirror(), swapProvider = Sources.standalone();
        let swapOwner, genuineSwap;
        const swapResult = thrown(() => swapMirror.attachStore('actors', (actualOwner, actualDescriptor) => {
            swapOwner = actualOwner;
            genuineSwap = swapProvider.createStore(actualOwner, actualDescriptor);
            return Object.freeze(Object.create(genuineSwap)); // Complete shape, wrong backing identity.
        }));
        assert.equal(swapResult.didThrow, true); assert(swapResult.value instanceof TypeError);
        assert.equal(Sources.actorStoreIndex(swapOwner), null);
        assert.equal(Sources.actorStoreMatches(swapOwner, genuineSwap), false);
        assert.equal(TableMirror.actorStoreOwner(swapOwner), null);
        assert.equal(swapMirror.tables.has('actors'), false);
        unknown(() => TableMirror.actorStoreRead(swapOwner));
        assert.equal(Sources.actorStoreMatches(owner, store), true); currentRefs();
        groups.push('authentic_clone_pure_owner_exact_mirror_second_constructor_refusals');

        const privateHeld = store.entries(), indexHeld = index.sourceValues('actor');
        const portHeld = port.sourceEntries('actor'), finalReceipt = TableMirror.actorStoreRead(owner);
        const retainedRecord = index.get(1);
        store.dispose();
        assert.equal(Sources.actorStoreIndex(owner), null);
        assert.equal(Sources.actorStoreMatches(owner, store), false);
        assert.equal(TableMirror.actorStoreReadCurrent(owner, finalReceipt), false);
        everyUnknown(index); for (const call of facadeCalls(facade)) unknown(call);
        unknown(() => indexHeld.next()); refused(() => privateHeld.next()); refused(() => store.get(1));
        refused(() => Sources.native()); refused(() => native.createStore(pureOwner, TableMirror.actorStoreOwner(pureOwner).descriptor));
        // Genuine port is INDEX lifetime, not owner lifetime: no blanket revocation.
        assert.equal(Runtime.actorProducerReads(), port);
        assert.equal(port.getSource(1, 'actor'), retainedRecord);
        assert.equal(port.sourceSize('actor'), 2);
        assert.deepEqual(portHeld.next(), { value: [1, retainedRecord], done: false });
        assert.equal(tables.detachStore('actors'), true);
        assert.equal(TableMirror.nativeActorMirrorOwner(tables), null);
        refused(() => Runtime.nativeActorMirror()); refused(() => new TableMirror({ actorProjectorRole: role }));
        everyUnknown(index); assert.equal(Runtime.actorProducerReads(), port); conserveState();
        pureStore.dispose(); assert.equal(Sources.actorStoreIndex(pureOwner), null);
        assert.deepEqual(stateIterator.next(), { value: 1, done: false });
        assert.deepEqual(stateIterator.next(), { value: undefined, done: true });
        groups.push('dispose_reacquire_sticky_refusal_private_vs_producer_port_lifetime');
        assert.equal(groups.length, 11);
        assert.equal(fs.existsSync(workerData.generated.world), false);
        assert.equal(fs.existsSync(workerData.generated.history), false);
        const loaded = noGameImports();
        assert.deepEqual(observer.requests.filter(blocked), []);
        parentPort.postMessage({ kind: 'HELPER_ONLY_ACTOR_ALL_READ_FUTURE_ACCEPTANCE', isMainThread, threadId,
            groups, aliases: actorReads(index).map(item => item[0]), cleanupReports: progressLog,
            loaded, forbiddenRequests: [], stateOriginalConserved: true,
            genericSpotGroupMembershipClaim: false, gameWorkerOrWireProof: false });
    } finally { observer.restore(); }
}

async function hostMain() {
    const keys = ['L2NODE_CONFIG_FILE', 'L2NODE_SHARED_CONFIG_FILE', 'BOT_KNOWLEDGE_ERRORS_ENABLED', 'NODE_OPTIONS'];
    const environmentBefore = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n62-helper-actor-all-read-'));
    const generated = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite'),
        config: path.join(directory, 'default-isolated.ini') };
    let worker, joined = false, terminationCode = null, observer, Runtime, singletonActor, singletonState;
    let actorSource, stateSource;
    try {
        const defaultConfig = fs.readFileSync(path.join(gameRoot, 'config/default.ini'), 'utf8');
        const databaseHeader = /^\[Database\]\r?\npath\s*=\s*[^\r\n]+/m;
        assert(databaseHeader.test(defaultConfig));
        fs.writeFileSync(generated.config, defaultConfig.replace(databaseHeader,
            `[Database]\npath = ${generated.world}\nhistoryPath = ${generated.history}`));
        process.env.L2NODE_CONFIG_FILE = generated.config;
        process.env.BOT_KNOWLEDGE_ERRORS_ENABLED = 'false';
        delete process.env.L2NODE_SHARED_CONFIG_FILE; delete process.env.NODE_OPTIONS;
        observer = installLoadObserver();
        Runtime = moduleAt('World/CharacterLocationRuntime');
        const Index = moduleAt('World/CharacterLocationIndex'), TableMirror = moduleAt('Bot/Population/TableMirror');
        actorSource = { nativeMain: true, loc: point }; stateSource = { nativeState: true, loc: point };
        singletonActor = { id: 91, source: actorSource, phase: 'hot', loc: () => point };
        singletonState = { id: 91, source: stateSource, phase: 'cold', loc: () => point };
        Runtime.index.setSource(91, 'actor', singletonActor);
        Runtime.index.setSource(91, 'state', singletonState);
        const independent = new Index({ legacyStateCache: true });
        independent.setSource(91, 'actor', singletonActor); independent.setSource(91, 'state', singletonState);
        const defaultMirror = new TableMirror(), ordinary = { original: true };
        assert.deepEqual(defaultMirror.apply([{ name: 'fixture-default', from: null, to: 1, full: true,
            last: 1, rows: [[91, ordinary]], removed: [] }]), []);
        const mainHeld = Runtime.index.sourceValues('actor'), stateHeld = independent.sourceEntries('state');
        const conserveMain = () => {
            for (const index of [Runtime.index, independent]) {
                assert.equal(index.get(91), singletonActor); assert.equal(index.get(91).source, actorSource);
                assert.equal(index.getSource(91, 'state'), singletonState);
                assert.deepEqual(index.near(point, 0), [singletonActor]);
                assert.deepEqual(index.nearSources(point, 0, { view: 'state' }), [singletonState]);
            }
            assert.equal(defaultMirror.rows('fixture-default').get(91), ordinary);
            assert.equal(defaultMirror.ready('fixture-default'), true);
            assert.deepEqual(defaultMirror.summary(), { 'fixture-default': {
                version: 1, rows: 1, waiting: false, loading: false } });
        };
        conserveMain(); noGameImports();
        worker = new Worker(__filename, { name: 'actor-all-read-helper-only', execArgv: [],
            env: { ...process.env, N53_GAME_ROOT: gameRoot },
            workerData: { sourceRoot: gameRoot, workerEpoch: 'actor-read-helper-worker-1', generated } });
        const finished = await new Promise((resolve, reject) => {
            const messages = [], timer = setTimeout(() => reject(new Error('helper actor Worker did not exit')), 10000);
            worker.on('message', value => { messages.push(value); });
            worker.once('error', error => { clearTimeout(timer); reject(error); });
            worker.once('exit', code => { clearTimeout(timer); joined = true; resolve({ code, messages }); });
        });
        assert.equal(finished.code, 0); assert.equal(finished.messages.length, 1);
        const result = finished.messages[0];
        assert.equal(result.kind, 'HELPER_ONLY_ACTOR_ALL_READ_FUTURE_ACCEPTANCE');
        assert.equal(result.isMainThread, false); assert(result.threadId > 0);
        assert.equal(result.groups.length, 11); assert.equal(result.aliases.length, 12);
        assert.deepEqual(result.forbiddenRequests, []); assert.equal(result.stateOriginalConserved, true);
        conserveMain();
        assert.deepEqual(mainHeld.next(), { value: singletonActor, done: false });
        assert.deepEqual(mainHeld.next(), { value: undefined, done: true });
        assert.deepEqual(stateHeld.next(), { value: [91, singletonState], done: false });
        assert.deepEqual(stateHeld.next(), { value: undefined, done: true });
        noGameImports(); assert.deepEqual(observer.requests.filter(blocked), []);
        assert.deepEqual(fs.readdirSync(directory), ['default-isolated.ini']);
        console.log('OBSERVATIONS ' + JSON.stringify({ workerExit: finished.code, joined, ...result,
            parentMainDefaultOriginalsConserved: true }));
    } finally {
        if (worker && !joined) { terminationCode = await worker.terminate(); joined = true; }
        if (Runtime && actorSource) Runtime.index.removeSource(91, 'actor', actorSource);
        if (Runtime && stateSource) Runtime.index.removeSource(91, 'state', stateSource);
        observer?.restore();
        for (const key of keys) {
            if (environmentBefore[key] === undefined) delete process.env[key];
            else process.env[key] = environmentBefore[key];
        }
        const filesBeforeRemoval = fs.readdirSync(directory);
        fs.rmSync(directory, { recursive: true, force: true });
        console.log('CLEANUP ' + JSON.stringify({ joined, terminationCode, filesBeforeRemoval,
            directoryRemoved: !fs.existsSync(directory), bothDatabaseFilesAbsent: !fs.existsSync(generated.world)
                && !fs.existsSync(generated.history), environmentRestored: keys.every(key => process.env[key] === environmentBefore[key]) }));
        assert.equal(fs.existsSync(directory), false);
        assert.equal(keys.every(key => process.env[key] === environmentBefore[key]), true);
    }
}

if (isMainThread) hostMain().catch(error => { console.error(error); process.exitCode = 1; });
else workerMain();
