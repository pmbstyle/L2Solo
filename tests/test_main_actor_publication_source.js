'use strict';

// UNEXECUTED future native issuer contract. An approved helper/Root assembly
// is required; missing future exports are not a repeated BEFORE regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const previousCwd = process.cwd();
const environmentKeys = ['L2NODE_CONFIG_FILE', 'L2NODE_SHARED_CONFIG_FILE', 'BOT_KNOWLEDGE_ERRORS_ENABLED'];
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n62-native-issuer-green-'));
const generated = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
const disposers = [], restorers = [], restorationChecks = [], observations = [], dirty = [], faults = [];
let World, Actor, Life, Database, Runtime, issuer, previousUser, previousPaths, previousKnowledge;
let serial = 9975000, stateConserved = () => {};
function observe(name, details = {}) { observations.push({ name, ...details }); console.log('PASS ' + name); }
function shadow(target, key, value) {
    const old = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: old?.enumerable ?? false });
    const restore = () => { if (old) Object.defineProperty(target, key, old); else delete target[key]; };
    restorers.push(restore);
    restorationChecks.push(() => {
        const actual = Object.getOwnPropertyDescriptor(target, key);
        return old ? ['value', 'get', 'set', 'writable', 'configurable', 'enumerable'].every(field => actual?.[field] === old[field])
            : actual === undefined;
    });
    return restore;
}
function member({ id = ++serial, account = `player_issuer_${++serial}` } = {}) {
    const session = { accountId: account, fetchAccountId() { return this.accountId; },
        socket: { destroy() { session.destroyed = true; } }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    session.actor = new Actor({ id, username: account, name: account, clanId: 0, isOnline: false,
        locX: 0, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
    session.actor.session = session;
    World.insertUser(session); session.actor.setIsOnline(true);
    return session;
}
function source(id) {
    const capture = issuer.capture();
    for (let inspected = 0; inspected < capture.count; inspected++) {
        const entry = capture.entries.next();
        assert.equal(entry.done, false);
        if (entry.value.id === id) return { ref: entry.value, occurrence: capture.bindingOccurrence };
    }
    assert.fail('generated registered source not present');
}
function resolve(evidence) { return issuer.resolve(evidence.ref, evidence.occurrence); }
function put(evidence) {
    const result = resolve(evidence); assert.equal(result.kind, 'put');
    assert.equal(result.occurrence, evidence.occurrence); assert.equal(result.current(), true);
    assert(Object.isFrozen(result.row)); assert(Object.isFrozen(result.row.axes));
    for (const axis of ['x', 'y', 'z']) assert(Object.isFrozen(result.row.axes[axis]));
    return result;
}
function subscribe(listener, onError) { const dispose = issuer.subscribe(listener, onError); disposers.push(dispose); return dispose; }

try {
    process.chdir(gameRoot);
    process.env.L2NODE_CONFIG_FILE = path.join(gameRoot, 'config/default.ini');
    delete process.env.L2NODE_SHARED_CONFIG_FILE;
    process.env.BOT_KNOWLEDGE_ERRORS_ENABLED = 'false';
    const originalLoad = Module._load, worldLoadAttempts = [];
    let Native;
    try {
        Module._load = function(request, ...args) {
            const issuerParent = args[0]?.filename === path.join(gameRoot, 'src/GameServer/World/MainActorPublicationSource.js');
            if (typeof request === 'string' && (/[/\\]World[/\\]World(?:\.js)?$/.test(request)
                || (request === './World' && issuerParent))) worldLoadAttempts.push(request);
            return Reflect.apply(originalLoad, this, [request, ...args]);
        };
        Native = require(path.join(gameRoot, 'src/GameServer/World/MainActorPublicationSource'));
        for (const argument of [undefined, null, {}, () => true]) assert.throws(() => Native.native(argument), TypeError);
    } finally { Module._load = originalLoad; }
    assert.deepEqual(worldLoadAttempts, [], 'argument refusal precedes any World loading');

    require(path.join(gameRoot, 'src/Global'));
    previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
    previousKnowledge = options.default.BotPopulation.knowledgeErrorsEnabled;
    options.default.Database.path = generated.world; options.default.Database.historyPath = generated.history;
    options.default.BotPopulation.knowledgeErrorsEnabled = false;
    World = invoke('GameServer/World/World'); Actor = invoke('GameServer/Model/Actor');
    Life = invoke('GameServer/Bot/Population/BotLifeState'); Database = invoke('Database');
    Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
    previousUser = World.user;
    assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled(), false);
    World.user = null;
    issuer = Native.native(); assert.equal(Native.native(), issuer);
    const startup = issuer.capture(), startupOccurrence = issuer.currentOccurrence();
    assert.equal(startup.bindingOccurrence, startupOccurrence); assert.equal(startupOccurrence.binding, null);
    assert.equal(startup.count, 0); assert.equal(startup.entries.next().done, true);
    assert.throws(() => issuer.subscribe(() => {}), TypeError);
    assert.throws(() => issuer.subscribe(null, () => {}), TypeError);
    subscribe(event => dirty.push(event), (error, occurrence) => faults.push({ error, occurrence }));
    assert.deepEqual(dirty, [], 'subscribe does not fabricate a bootstrap replay');

    World.user = { sessions: [], revision: 0 };
    const first = member(), second = member(), id = first.actor.fetchId();
    const originalRecord = World.registeredActorById(id);
    assert.equal(originalRecord.actor, first.actor); assert.equal(originalRecord.session, first);
    assert(World.realPlayerSessionsNear({ locX: 0, locY: 0, locZ: 0 }, 1).includes(first));
    const firstState = Life.acceptLifecycleRow({ characterId: id, phase: 'cold', activity: 'hunting',
        level: 10, hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 1,
        inventorySummary: JSON.stringify({ 1864: { selfId: 1864, amount: 12 } }) });
    const actorSlot = Runtime.index.getSource(id, 'actor'), stateSlot = Runtime.index.getSource(id, 'state');
    assert.equal(actorSlot, originalRecord); assert.equal(stateSlot.source, firstState);
    assert.equal(firstState.inventory[1864].amount, 12);
    const axisReads = { x: 0, y: 0, z: 0 };
    const stopCounters = [first, second].flatMap(session => ['X', 'Y', 'Z'].map(axis => {
        const method = 'fetchLoc' + axis, original = session.actor[method];
        return shadow(session.actor, method, function() { axisReads[axis.toLowerCase()]++; return Reflect.apply(original, this, []); });
    }));
    const originalEntries = Runtime.index.sourceEntries;
    let nativeNext = 0;
    const stopIteratorObserver = shadow(Runtime.index, 'sourceEntries', function(view) {
        const original = Reflect.apply(originalEntries, this, [view]);
        return { next(...args) { nativeNext++; return Reflect.apply(original.next, original, args); },
            [Symbol.iterator]() { return this; } };
    });
    const capture = issuer.capture(); assert.equal(nativeNext, 0, 'capture does not pull native source entries');
    const refs = [capture.entries.next().value]; assert.equal(nativeNext, 1);
    refs.push(capture.entries.next().value); assert.equal(nativeNext, 2);
    assert.equal(capture.count, 2); assert.equal(capture.entries.next().done, true); assert.equal(nativeNext, 3);
    stopIteratorObserver();
    assert.deepEqual(axisReads, { x: 0, y: 0, z: 0 }, 'count and one-next lazy refs perform no coordinate prepass');
    assert.deepEqual(refs.map(ref => ref.id), [id, second.actor.fetchId()]);
    assert.equal(refs[0].record, originalRecord); assert.equal(refs[0].token, originalRecord.token);
    assert(Object.isFrozen(refs[0]));
    const published = dirty.find(event => event.kind === 'dirty' && event.ref.record === originalRecord);
    assert(published); assert.equal(published.ref, refs[0]); assert.equal(published.occurrence, capture.bindingOccurrence);
    const firstEvidence = { ref: refs[0], occurrence: capture.bindingOccurrence }, firstPut = put(firstEvidence);
    assert.equal(firstPut.row.order, originalRecord.order); assert.deepEqual(axisReads, { x: 1, y: 1, z: 1 });
    assert.equal(firstPut.current(), true); assert.deepEqual(axisReads, { x: 1, y: 1, z: 1 }, 'receipt reads identity only');
    stopCounters.forEach(stop => stop());
    const currentState = Life.acceptLifecycleRow({ characterId: id, phase: 'cold', activity: 'hunting',
        level: 10, hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 2,
        inventorySummary: JSON.stringify({ 1864: { selfId: 1864, amount: 31 } }) });
    const currentStateRecord = Runtime.index.getSource(id, 'state'), stateBefore = structuredClone(currentState);
    stateConserved = () => {
        assert.equal(Life.cachedState(id), currentState); assert.equal(currentStateRecord.source, currentState);
        assert.equal(Runtime.index.getSource(id, 'state'), currentStateRecord); assert.deepEqual(currentState, stateBefore);
    };
    assert.notEqual(currentState, firstState); assert.equal(currentState.inventory[1864].amount, 31);
    assert.equal(Runtime.index.getSource(id, 'actor'), originalRecord); assert.equal(firstPut.current(), true);
    stateConserved(); observe('native null startup, original refs/order/count and no axis prepass; independent actual state12 to31');

    assert.throws(() => { refs[0].id = -1; }, TypeError);
    assert.equal(issuer.resolve(Object.freeze({ ...refs[0] }), capture.bindingOccurrence).kind, 'refused');
    assert.equal(issuer.resolve(null, capture.bindingOccurrence).kind, 'refused');
    assert.throws(() => { firstPut.row.id = -1; }, TypeError);
    assert.throws(() => { firstPut.row.axes.x.value = 7; }, TypeError);
    assert.equal(firstPut.row.id, id); assert.equal(firstPut.current(), true);
    first.actor.setLocXYZ({ locX: -0, locY: '42', locZ: null });
    const moved = put(firstEvidence);
    assert.equal(moved.row.sourceGeneration, firstPut.row.sourceGeneration);
    assert(moved.row.publication > firstPut.row.publication); assert.equal(firstPut.current(), false);
    assert(Object.is(moved.row.axes.x.value, -0)); assert(Object.is(structuredClone(moved.row).axes.x.value, -0));
    assert.deepEqual(moved.row.axes.y, { tag: 'string', value: '42' }); assert.deepEqual(moved.row.axes.z, { tag: 'null' });
    World.retireUserActor(first, first.actor);
    const retired = put(firstEvidence), retiredRecord = World.registeredActorById(id);
    assert.notEqual(retiredRecord, originalRecord); assert.equal(retiredRecord.actor, first.actor);
    assert.notEqual(retired.row.sourceGeneration, moved.row.sourceGeneration);
    first.actor.setLocX(12);
    const lateRetired = put(firstEvidence);
    assert.equal(lateRetired.row.sourceGeneration, retired.row.sourceGeneration);
    assert.equal(World.registeredActorById(id), retiredRecord); assert.equal(retiredRecord.retired, true);
    assert.equal(Runtime.index.near({ locX: 12, locY: 42, locZ: 0 }, 1).includes(retiredRecord), false);
    stateConserved(); observe('frozen issued refs/DTOs, same-wrapper motion and renewed retired token without revival');

    const replacement = member({ id, account: first.accountId }), replacementEvidence = source(id);
    const replacementPut = put(firstEvidence);
    assert.equal(World.registeredActorById(id).session, replacement);
    assert.equal(replacementPut.row.sourceGeneration, put(replacementEvidence).row.sourceGeneration);
    assert.equal(replacementEvidence.ref.record, World.registeredActorById(id));
    const later = member({ id, account: first.accountId }), laterEvidence = source(id);
    assert.equal(put(replacementEvidence).row.sourceGeneration, put(laterEvidence).row.sourceGeneration, 'stale B resolves current C');
    World.removeUser(later);
    const absent = resolve(replacementEvidence);
    assert.equal(absent.kind, 'remove'); assert.equal(absent.row.id, id); assert.equal(absent.current(), true);
    assert(absent.row.throughPublication >= replacementPut.row.publication, 'true absence cutoff covers an older delivered A');
    const newest = member({ id, account: first.accountId }), newestEvidence = source(id), newestPut = put(newestEvidence);
    assert.equal(absent.current(), false); assert(newestPut.row.publication > absent.row.throughPublication);
    assert.equal(put(replacementEvidence).row.sourceGeneration, newestPut.row.sourceGeneration);
    const originalNewestActor = newest.actor;
    newest.actor = second.actor;
    assert.equal(resolve(newestEvidence).kind, 'refused', 'incoherent present raw slot is not a tombstone');
    newest.actor = originalNewestActor;
    assert.equal(World.registeredActorById(id), newestEvidence.ref.record);
    stateConserved(); observe('stale B toC, A toB removal cutoff, laterC protection and incoherent-presence refusal');

    const unsupported = { [Symbol.toPrimitive]() { assert.fail('unsupported conversion'); },
        valueOf() { assert.fail('unsupported valueOf'); }, toString() { assert.fail('unsupported String'); } };
    const axisCases = [[true, { tag: 'boolean', value: true }], [undefined, { tag: 'undefined' }],
        [NaN, { tag: 'nonfinite' }], [Infinity, { tag: 'nonfinite' }], [1n, { tag: 'unsupported' }],
        [Symbol('axis'), { tag: 'unsupported' }], [unsupported, { tag: 'unsupported' }]];
    for (const [value, expected] of axisCases) {
        const stop = shadow(newest.actor, 'fetchLocZ', () => value);
        try { assert.deepEqual(put(newestEvidence).row.axes.z, expected); } finally { stop(); }
    }
    const providerError = new Error('native issuer original getter failure');
    const stopProvider = shadow(newest.actor, 'fetchLocZ', () => { throw providerError; });
    let refused;
    try { refused = resolve(newestEvidence); } finally { stopProvider(); }
    assert.equal(refused.kind, 'refused'); assert.equal(refused.error, providerError);
    assert.equal(put(newestEvidence).current(), true); stateConserved();
    observe('limited scalar tags and unsupported zero-conversion; original provider refusal then recovery');

    const earlier = put(newestEvidence), secondEvidence = source(second.actor.fetchId());
    const fetchSecondZ = second.actor.fetchLocZ;
    let reentered = false;
    const stopReentry = shadow(second.actor, 'fetchLocZ', function() {
        if (!reentered) { reentered = true; newest.actor.setLocX(211); }
        return Reflect.apply(fetchSecondZ, this, []);
    });
    try { put(secondEvidence); } finally { stopReentry(); }
    assert.equal(reentered, true); assert.equal(earlier.current(), false);
    assert.equal(put(newestEvidence).current(), true); stateConserved();
    observe('later native getter publication invalidates earlier receipt without re-reading its axes');

    let received = 0, attachmentUnknown = false;
    const isolatedError = new Error('isolated subscriber fault'), deliveredFaults = [];
    const badSubscription = subscribe(() => { received++; throw isolatedError; }, (error, occurrence) => {
        attachmentUnknown = true; deliveredFaults.push({ error, occurrence, received });
        newest.actor.setLocY(17);
        return true; // A consumer return is observational, never native authority/recovery.
    });
    newest.actor.setLocX(218);
    assert.equal(received, 1, 'suspended BEFORE reentrant onError producer');
    assert.equal(attachmentUnknown, true); assert.equal(deliveredFaults.length, 1);
    assert.equal(deliveredFaults[0].error, isolatedError); assert.equal(deliveredFaults[0].occurrence, issuer.currentOccurrence());
    newest.actor.setLocZ(3); assert.equal(received, 1);
    badSubscription(); badSubscription();
    let recoveredCalls = 0;
    const recoverySubscription = subscribe(() => { recoveredCalls++; }, (error, occurrence) => faults.push({ error, occurrence }));
    assert.equal(recoveredCalls, 0); newest.actor.setLocX(219); assert.equal(recoveredCalls, 1);
    recoverySubscription(); stateConserved(); observe('faulty subscriber suspended before unknown notification; explicit new subscription only');

    const beforeReset = issuer.currentOccurrence(), held = issuer.capture();
    World.user = null;
    const firstNull = issuer.currentOccurrence();
    assert.notEqual(firstNull, beforeReset); assert.equal(firstNull.binding, null);
    assert.throws(() => held.entries.next(), 'held iterator changed occurrence refuses, not empty completion');
    assert.equal(resolve(newestEvidence).kind, 'refused');
    World.user = undefined; assert.equal(issuer.currentOccurrence(), firstNull);
    let trigger = true;
    const resetEvents = [];
    const stopAba = World.subscribeActorPublications(packet => {
        if (packet.kind === 'reset' && packet.binding === null && trigger) {
            trigger = false; World.user = { sessions: [], revision: 0 }; World.user = null;
        }
    });
    disposers.push(stopAba);
    const stopResetObserver = subscribe(event => { if (event.kind === 'reset') resetEvents.push(event.occurrence); },
        (error, occurrence) => faults.push({ error, occurrence }));
    World.user = { sessions: [], revision: 0 }; const beforeAba = issuer.currentOccurrence();
    World.user = null;
    const finalNull = issuer.currentOccurrence();
    assert.equal(finalNull.binding, null); assert.notEqual(finalNull, firstNull); assert.notEqual(finalNull, beforeAba);
    assert(finalNull.worldGeneration > firstNull.worldGeneration);
    assert.equal(resetEvents.at(-1), finalNull); stopAba(); stopResetObserver(); stateConserved();
    observe('nullable reset occurrence and ABA, held iterator/source receipts invalidated while state preserved');

    World.user = { sessions: [], revision: 0 };
    const faultActor = member(), faultEvidence = source(faultActor.actor.fetchId()), beforeFault = put(faultEvidence);
    assert.deepEqual(faults, [], 'healthy recorder has no fault before deliberate global failure');
    const deliveryError = new Error('listener before global latch'), handlerThrownValue = undefined;
    // The original thrown value can be falsy; truthiness is not failure state.
    const stopFatal = subscribe(() => { throw deliveryError; }, () => { throw handlerThrownValue; });
    const originalUpdate = Runtime.index.updateSource;
    let nativeError;
    const stopNativeObserver = shadow(Runtime.index, 'updateSource', function(...args) {
        try { return Reflect.apply(originalUpdate, this, args); }
        catch (error) { nativeError = error; throw error; }
    });
    let thrown;
    try { faultActor.actor.setLocX(1e100); } catch (error) { thrown = error; }
    finally { stopNativeObserver(); }
    assert(nativeError instanceof RangeError); assert.equal(thrown, nativeError, 'accepted-prefix publication preserves ORIGINAL native Error');
    assert.equal(beforeFault.current(), false); assert.equal(resolve(faultEvidence).kind, 'refused');
    let captureThrew = false, captureThrown;
    try { issuer.capture(); } catch (error) { captureThrew = true; captureThrown = error; }
    assert.equal(captureThrew, true); assert.equal(captureThrown, handlerThrownValue);
    let occurrenceThrew = false, occurrenceThrown;
    try { issuer.currentOccurrence(); } catch (error) { occurrenceThrew = true; occurrenceThrown = error; }
    assert.equal(occurrenceThrew, true); assert.equal(occurrenceThrown, handlerThrownValue);
    stopFatal();
    let inert, subscribeThrew = false, subscribeThrown;
    try { inert = subscribe(() => {}, (error, occurrence) => faults.push({ error, occurrence })); }
    catch (error) { subscribeThrew = true; subscribeThrown = error; }
    assert.equal(subscribeThrew, true); assert.equal(subscribeThrown, handlerThrownValue);
    faultActor.actor.setLocX(2);
    assert.equal(resolve(faultEvidence).kind, 'refused', 'new subscription/native motion cannot clear permanent issuer failure');
    inert?.(); stateConserved(); observe('onError fault permanently fail-closes issuer without masking native accepted-prefix RangeError');

    issuer.dispose(); issuer.dispose();
    assert.equal(beforeFault.current(), false); assert.throws(() => Native.native());
    const afterDisposeCount = dirty.length;
    faultActor.actor.setLocX(3);
    assert.equal(dirty.length, afterDisposeCount);
    assert.equal(Runtime.index.getSource(faultEvidence.ref.id, 'actor'), faultEvidence.ref.record);
    stateConserved(); observe('terminal disposal invalidates receipts and leaves current native actor/state sources intact');
    assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(observations.length, 9);
    console.log('OBSERVATIONS ' + JSON.stringify(observations));
} finally {
    for (const dispose of disposers.reverse()) dispose();
    issuer?.dispose();
    for (const restore of restorers.reverse()) restore();
    const cleanup = { databaseReady: Database?.isReady() === true, filesCreated: fs.readdirSync(directory), generatedPaths: generated };
    if (World) World.user = previousUser;
    if (previousPaths) {
        options.default.Database.path = previousPaths.world; options.default.Database.historyPath = previousPaths.history;
        options.default.BotPopulation.knowledgeErrorsEnabled = previousKnowledge;
    }
    for (const key of environmentKeys) {
        if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
    }
    process.chdir(previousCwd); fs.rmSync(directory, { recursive: true, force: true });
    Object.assign(cleanup, { unsubscribes: disposers.length, shadowsRestored: restorationChecks.every(check => check()),
        previousWorldRestored: World?.user === previousUser, directoryRemoved: !fs.existsSync(directory),
        pathsAbsent: !fs.existsSync(generated.world) && !fs.existsSync(generated.history), Worker: 0, server: 0,
        generatedLifeStateLifetime: 'retained original conserved source until isolated process exit; no artificial cache clear' });
    const loadedSources = Object.keys(require.cache).filter(filename => filename.startsWith(path.join(gameRoot, 'src') + path.sep))
        .map(filename => ({ path: filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }));
    if (process.env.N62_NATIVE_ISSUER_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.N62_NATIVE_ISSUER_EVIDENCE_DIR, 'observations.json'),
        JSON.stringify({ observations, dirtyCount: dirty.length, faultCount: faults.length, cleanup, loadedSources }, null, 2) + '\n');
    console.log('CLEANUP ' + JSON.stringify(cleanup));
}
