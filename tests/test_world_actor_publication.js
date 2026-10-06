'use strict';

// FUTURE GREEN source-only candidate. Execute only against an approved Root
// assembly with the dedicated publication APIs, never as a repeated BEFORE.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const previousCwd = process.cwd();
const environmentKeys = ['L2NODE_CONFIG_FILE', 'L2NODE_SHARED_CONFIG_FILE', 'BOT_KNOWLEDGE_ERRORS_ENABLED'];
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n62-actor-publication-green-'));
const generated = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
const disposers = [], restorers = [], restorationChecks = [], deliveries = [], legacyIds = [], observations = [];
let World, Actor, Life, Database, Runtime, previousUser, previousPaths, previousKnowledge, stateConserved;
let serial = 9990000;
const partyId = 'publication_native_group', partyKey = `party:${partyId}`;
function observe(name, details = {}) { observations.push({ name, ...details }); console.log('PASS ' + name); }
function subscribe(listener) { const dispose = World.subscribeActorPublications(listener); disposers.push(dispose); return dispose; }
function shadow(target, key, value) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    target[key] = value;
    const restore = () => { if (previous) Object.defineProperty(target, key, previous); else delete target[key]; };
    restorationChecks.push(() => {
        const actual = Object.getOwnPropertyDescriptor(target, key);
        if (!previous) return actual === undefined;
        return ['value', 'get', 'set', 'writable', 'configurable', 'enumerable'].every(field => actual?.[field] === previous[field]);
    });
    restorers.push(restore); return restore;
}
function member({ id = ++serial, account = `player_actor_green_${++serial}`, party = false } = {}) {
    const session = { accountId: account, fetchAccountId() { return this.accountId; },
        socket: { destroy() { session.destroyed = true; } }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    if (party) session.coldLifeState = { party: { partyId } };
    session.actor = new Actor({ id, username: account, name: account, clanId: 0, isOnline: false,
        locX: 0, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
    session.actor.session = session;
    World.insertUser(session); session.actor.setIsOnline(true);
    return session;
}
function window(action) {
    const start = deliveries.length, oldStart = legacyIds.length;
    const result = action();
    return { result, deliveries: deliveries.slice(start), legacyIds: legacyIds.slice(oldStart) };
}
function current(id) { return World.registeredActorById(id); }
function near(session, point) { assert(World.realPlayerSessionsNear(point, 1).includes(session)); }
function assertCurrentDelivery(delivery, record) {
    assert(Object.isFrozen(delivery.packet)); assert.equal(delivery.packet.record, record);
    assert.equal(delivery.currentAtDelivery, record);
    assert.equal(delivery.packet.binding, delivery.bindingAtDelivery);
    assert.equal(delivery.packet.binding, World.actorPublicationBinding);
}
function location(action, record, point) {
    const observed = window(action);
    assert.equal(observed.result, undefined);
    assert.equal(observed.deliveries.length, 1, 'one current registered native update yields one publication');
    const delivered = observed.deliveries[0];
    assert.equal(delivered.packet.kind, 'upsert'); assert.equal(delivered.packet.cause, 'location');
    assertCurrentDelivery(delivered, record); assert.deepEqual(observed.legacyIds, []);
    if (point) near(record.session, point);
    stateConserved(); return observed;
}

try {
    process.chdir(gameRoot);
    process.env.L2NODE_CONFIG_FILE = path.join(gameRoot, 'config/default.ini');
    delete process.env.L2NODE_SHARED_CONFIG_FILE;
    process.env.BOT_KNOWLEDGE_ERRORS_ENABLED = 'false';
    require(path.join(gameRoot, 'src/Global'));
    previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
    previousKnowledge = options.default.BotPopulation.knowledgeErrorsEnabled;
    options.default.Database.path = generated.world; options.default.Database.historyPath = generated.history;
    options.default.BotPopulation.knowledgeErrorsEnabled = false;
    World = invoke('GameServer/World/World'); Actor = invoke('GameServer/Model/Actor');
    Life = invoke('GameServer/Bot/Population/BotLifeState'); Database = invoke('Database');
    Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
    previousUser = World.user;
    assert.equal(invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled(), false);
    assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(typeof World.subscribeActorPublications, 'function');
    assert.throws(() => World.subscribeActorPublications(null), TypeError);
    disposers.push(World.subscribeUserChanges(id => legacyIds.push(id)));
    // No assertions inside observers: notification error isolation must not
    // turn an assertion thrown from a callback into a misleading PASS.
    subscribe(packet => deliveries.push({ packet, userAtDelivery: World.user,
        bindingAtDelivery: World.actorPublicationBinding,
        currentAtDelivery: packet.record ? current(packet.record.id) : null,
        groupAtDelivery: packet.record?.session.coldLifeState?.party?.partyId === partyId
            ? World.pvpPartySessionsForKey(partyKey) : null }));
    World.user = { sessions: [], revision: 0 };
    const first = member({ party: true }), actor = first.actor, id = actor.fetchId(), record = current(id);
    assert.equal(record.actor, actor); assert.equal(record.session, first);
    assert.equal(Runtime.index.getSource(id, 'actor'), record);
    assert.equal(World.actorPublicationBinding, Runtime.bindWorld(World.user));
    const attach = deliveries.find(delivery => delivery.packet.kind === 'upsert'
        && delivery.packet.cause === 'attach' && delivery.packet.record === record);
    assert(attach); assertCurrentDelivery(attach, record);
    assert.deepEqual(attach.groupAtDelivery, [first], 'actual native group is published before actor attach evidence');
    assert(legacyIds.includes(id)); near(first, { locX: 0, locY: 0, locZ: 0 });
    const state = Life.acceptLifecycleRow({ characterId: id, phase: 'cold', activity: 'hunting',
        level: 10, hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 1 });
    const stateRecord = Runtime.index.getSource(id, 'state'), stateBefore = structuredClone(state);
    stateConserved = () => {
        assert.equal(Runtime.index.getSource(id, 'state'), stateRecord); assert.equal(stateRecord.source, state);
        assert.equal(Life.cachedState(id), state); assert.deepEqual(state, stateBefore);
    };
    stateConserved();
    let replayCalls = 0;
    const noReplay = subscribe(() => { replayCalls += 1; });
    assert.equal(replayCalls, 0); noReplay();
    observe('native attach original record/group precedes event, independent state and no replay');

    for (const [method, value, point] of [
        ['setLocX', 12000, { locX: 12000, locY: 0, locZ: 0 }],
        ['setLocY', 18000, { locX: 12000, locY: 18000, locZ: 0 }],
        ['setLocZ', 3300, { locX: 12000, locY: 18000, locZ: 3300 }]
    ]) location(() => actor[method](value), record, point);
    const outerPoint = { locX: 42000, locY: 24000, locZ: 4400 };
    location(() => actor.setLocXYZ(outerPoint), record, outerPoint);
    const offline = window(() => actor.setIsOnline(false));
    assert.deepEqual(offline.legacyIds, [id]); assert.equal(offline.deliveries.length, 1);
    assertCurrentDelivery(offline.deliveries[0], record);
    const online = window(() => actor.setIsOnline(true));
    assert.deepEqual(online.legacyIds, [id]); assert.equal(online.deliveries.length, 1);
    const sameUser = World.user;
    const unchanged = window(() => { World.user = sameUser; });
    assert.deepEqual(unchanged.deliveries, []); assert.deepEqual(unchanged.legacyIds, []); stateConserved();
    observe('direct and outer XYZ one current publication, old finite-point cadence unchanged');

    const retirement = window(() => World.retireUserActor(first, actor)), retired = current(id);
    assert.equal(retirement.result, true); assert.deepEqual(retirement.legacyIds, [id]);
    assert.equal(retirement.deliveries.length, 1); assert.notEqual(retired, record); assert.notEqual(retired.token, record.token);
    assert.equal(retirement.deliveries[0].packet.cause, 'retire'); assertCurrentDelivery(retirement.deliveries[0], retired);
    assert.deepEqual(retirement.deliveries[0].groupAtDelivery, [first], 'actual original group remains published at retirement');
    const observer = member(); observer.actor.setLocXYZ({ locX: 60000, locY: 30000, locZ: 0 });
    const terminalPoint = { locX: 60001, locY: 30000, locZ: 7700 };
    location(() => actor.setLocXYZ(terminalPoint), retired);
    assert.equal(current(id), retired); assert.equal(retired.retired, true);
    assert(World.botVisibleRealPlayers(observer, observer.actor).includes(first));
    assert(!World.realPlayerSessionsNear(terminalPoint, 1).includes(first)); stateConserved();
    observe('current retired raw point publishes on same token without generic revival');

    const replacementWindow = window(() => member({ id, account: first.accountId }));
    const replacement = replacementWindow.result, replaced = current(id);
    const oldRemoval = replacementWindow.deliveries.filter(delivery => delivery.packet.kind === 'remove' && delivery.packet.record === retired);
    assert.equal(oldRemoval.length, 1); assert.equal(oldRemoval[0].packet.binding, World.actorPublicationBinding);
    assert.notEqual(replaced, retired); assert.equal(replaced.actor, replacement.actor); assert.equal(first.destroyed, true);
    assert(replacementWindow.deliveries.some(delivery => delivery.packet.kind === 'upsert' && delivery.packet.record === replaced));
    assert.deepEqual(window(() => actor.setLocXYZ({ locX: 84000, locY: 84000, locZ: 0 })).deliveries, []);
    const duplicateWindow = window(() => member({ id })), duplicate = duplicateWindow.result, duplicateRecord = current(id);
    const displacedRemoval = duplicateWindow.deliveries.filter(delivery => delivery.packet.kind === 'remove' && delivery.packet.record === replaced);
    assert.equal(displacedRemoval.length, 1); assert.equal(displacedRemoval[0].packet.cause, 'replace');
    assert.equal(duplicateRecord.actor, duplicate.actor);
    const staleCleanup = window(() => World.removeUser(replacement));
    assert.deepEqual(staleCleanup.deliveries, []); assert.deepEqual(staleCleanup.legacyIds, [id]);
    assert.equal(current(id), duplicateRecord);
    const removal = window(() => World.removeUser(duplicate));
    assert.equal(removal.deliveries.length, 1); assert.equal(removal.deliveries[0].packet.kind, 'remove');
    assert.equal(removal.deliveries[0].packet.cause, 'remove'); assert.equal(removal.deliveries[0].packet.record, duplicateRecord);
    assert.deepEqual(removal.legacyIds, [id]); assert.equal(current(id), null);
    assert.deepEqual(window(() => duplicate.actor.setLocXYZ({ locX: 96000, locY: 0, locZ: 0 })).deliveries, []);
    const raceOld = member({ id }), raceOldRecord = current(id), raceLateEvents = [];
    let raceNewest = null;
    const stopReplacementRace = subscribe(packet => {
        if (packet.kind === 'remove' && packet.record === raceOldRecord && !raceNewest) raceNewest = member({ id });
    });
    const stopReplacementLate = subscribe(packet => raceLateEvents.push(packet));
    const raceCandidate = member({ id });
    assert(raceNewest); assert.equal(current(id).actor, raceNewest.actor);
    assert(!raceLateEvents.some(packet => packet.kind === 'upsert' && packet.record.actor === raceCandidate.actor),
        'old removal reentry cannot publish superseded outer accepted actor');
    assert(raceLateEvents.some(packet => packet.kind === 'upsert' && packet.record === current(id)));
    assert(raceLateEvents.some(packet => packet.kind === 'remove' && packet.record === raceOldRecord));
    stopReplacementRace(); stopReplacementLate();
    assert.equal(raceOldRecord.actor, raceOld.actor);
    const raceCleanup = window(() => World.removeUser(raceCandidate));
    assert.deepEqual(raceCleanup.deliveries, []); assert.equal(current(id).actor, raceNewest.actor);
    stateConserved(); observe('expected old-record replacement/removal and stale cleanup preserve new source');

    const faultSession = member(), faultActor = faultSession.actor, faultRecord = current(faultActor.fetchId());
    const prefixBefore = Runtime.index.records.get(faultRecord.id).actor.rawXY;
    let nativeError = null, warnAttempts = 0;
    const listenerError = new Error('controlled_publication_listener_error'), loggerError = new Error('controlled_publication_logger_error');
    const stopThrower = subscribe(packet => { if (packet.record === faultRecord && packet.cause === 'location') throw listenerError; });
    const afterFaultDeliveries = [];
    const stopAfterFault = subscribe(packet => {
        if (packet.record === faultRecord && packet.cause === 'location') afterFaultDeliveries.push({ packet,
            bindingAtDelivery: World.actorPublicationBinding, currentAtDelivery: current(faultRecord.id) });
    });
    const restoreWarn = shadow(utils, 'infoWarn', () => { warnAttempts += 1; throw loggerError; });
    const originalUpdateSource = Runtime.index.updateSource;
    const restoreUpdateSource = shadow(Runtime.index, 'updateSource', function (...args) {
        try { return Reflect.apply(originalUpdateSource, this, args); }
        catch (error) { nativeError = error; throw error; }
    });
    const errorStart = deliveries.length, errorLegacyStart = legacyIds.length;
    let caught = null;
    try { faultActor.setLocX(1e100); } catch (error) { caught = error; }
    assert(caught instanceof RangeError); assert.equal(caught, nativeError); assert.equal(caught.message, 'invalid_character_cell');
    assert.equal(faultActor.fetchLocX(), 1e100); assert.equal(current(faultRecord.id), faultRecord);
    const prefixAfter = Runtime.index.records.get(faultRecord.id).actor.rawXY;
    assert.notEqual(prefixAfter, prefixBefore); assert.equal(prefixAfter.record, faultRecord);
    const prefixEvents = deliveries.slice(errorStart);
    assert.equal(prefixEvents.length, 1); assert.equal(prefixEvents[0].packet.cause, 'location');
    assertCurrentDelivery(prefixEvents[0], faultRecord); assert.deepEqual(legacyIds.slice(errorLegacyStart), []);
    assert.equal(afterFaultDeliveries.length, 1, 'an observer after the failing listener still receives the native-error publication');
    assert.equal(afterFaultDeliveries[0].packet, prefixEvents[0].packet);
    assertCurrentDelivery(afterFaultDeliveries[0], faultRecord);
    assert(World.botVisibleRealPlayers(observer, faultActor).includes(faultSession), 'native raw-prefix membership is queryable at current source point');
    const faultRecovery = location(() => faultActor.setLocXYZ({ locX: 24000, locY: 0, locZ: 0 }), faultRecord, { locX: 24000, locY: 0, locZ: 0 });
    assert(warnAttempts >= 2, 'both original native Error and normal return survive listener/logger failures');
    assert.equal(afterFaultDeliveries.length, 2, 'the later observer also receives normal recovery despite listener/logger failure');
    assert.equal(afterFaultDeliveries[1].packet, faultRecovery.deliveries[0].packet);
    assertCurrentDelivery(afterFaultDeliveries[1], faultRecord);
    stopThrower(); stopAfterFault(); restoreWarn(); restoreUpdateSource(); stateConserved();
    observe('accepted raw prefix preserves original native Error and normal return despite listener/logger faults');

    const beforeBatchFacet = Runtime.index.records.get(faultRecord.id).actor.rawXY;
    const batchError = new Error('controlled_native_coords_getter_error');
    const beforeBatch = deliveries.length;
    let batchCaught = null;
    try { faultActor.setLocXYZ({ locX: 30000, get locY() { throw batchError; }, locZ: 0 }); }
    catch (error) { batchCaught = error; }
    assert.equal(batchCaught, batchError); assert.equal(faultActor.fetchLocX(), 30000);
    assert.equal(deliveries.length, beforeBatch); assert.equal(Runtime.index.records.get(faultRecord.id).actor.rawXY, beforeBatchFacet);
    const rawError = new Error('controlled_native_raw_getter_error');
    const restoreGetter = shadow(faultActor, 'fetchLocX', () => { throw rawError; });
    let rawCaught = null;
    try { faultActor.setLocX(31000); } catch (error) { rawCaught = error; }
    assert.equal(rawCaught, rawError); assert.equal(faultActor.model.locX, 31000);
    assert.equal(deliveries.length, beforeBatch); assert.equal(Runtime.index.records.get(faultRecord.id).actor.rawXY, beforeBatchFacet);
    restoreGetter(); location(() => faultActor.setLocXYZ({ locX: 36000, locY: 0, locZ: 0 }), faultRecord, { locX: 36000, locY: 0, locZ: 0 });
    observe('failure before accepted canonical publication keeps Error and partial Model, then native recovery');

    let disposedCalls = 0;
    const dispose = subscribe(() => { disposedCalls += 1; });
    assert.equal(disposedCalls, 0);
    location(() => faultActor.setLocY(12000), faultRecord, { locX: 36000, locY: 12000, locZ: 0 });
    assert.equal(disposedCalls, 1); dispose(); dispose();
    location(() => faultActor.setLocY(18000), faultRecord, { locX: 36000, locY: 18000, locZ: 0 });
    assert.equal(disposedCalls, 1);
    let addedCalls = 0, disposeAdded = null;
    const stopAdder = subscribe(() => { if (!disposeAdded) disposeAdded = subscribe(() => { addedCalls += 1; }); });
    location(() => faultActor.setLocY(24000), faultRecord, { locX: 36000, locY: 24000, locZ: 0 });
    assert.equal(addedCalls, 0, 'listener added inside current envelope does not join its captured delivery');
    location(() => faultActor.setLocY(30000), faultRecord, { locX: 36000, locY: 30000, locZ: 0 });
    assert.equal(addedCalls, 1); stopAdder(); disposeAdded(); stateConserved();
    observe('subscription disposal/addition preserves captured delivery and does not replay/bootstrap facts');

    let retiredInside = false;
    const lateSourceEvents = [];
    const stopReentry = subscribe(packet => {
        if (!retiredInside && packet.record === faultRecord && packet.cause === 'location') {
            retiredInside = true; World.retireUserActor(faultSession, faultActor);
        }
    });
    const stopLate = subscribe(packet => lateSourceEvents.push(packet));
    const reentered = window(() => faultActor.setLocZ(500));
    const innerRetired = current(faultRecord.id);
    assert.equal(reentered.result, undefined); assert.equal(retiredInside, true);
    assert.notEqual(innerRetired, faultRecord);
    assert(!lateSourceEvents.some(packet => packet.record === faultRecord));
    assert(lateSourceEvents.some(packet => packet.record === innerRetired && packet.cause === 'retire'));
    stopReentry(); stopLate(); stateConserved();
    const sourceBeforeReset = current(observer.actor.fetchId()), newUser = { sessions: [], revision: 0 };
    const originalFetchX = observer.actor.fetchLocX;
    let resetInsideGetter = false;
    const restoreResetGetter = shadow(observer.actor, 'fetchLocX', function () {
        if (!resetInsideGetter) { resetInsideGetter = true; World.user = newUser; }
        return Reflect.apply(originalFetchX, this, []);
    });
    const getterReentry = window(() => observer.actor.setLocX(72000)); restoreResetGetter();
    assert.equal(getterReentry.result, undefined); assert.equal(World.user, newUser);
    assert(getterReentry.deliveries.some(delivery => delivery.packet.kind === 'reset' && delivery.userAtDelivery === newUser));
    assert(!getterReentry.deliveries.some(delivery => delivery.packet.record === sourceBeforeReset));
    assert.equal(current(sourceBeforeReset.id), null); stateConserved();
    observe('source and binding reentry skip superseded callbacks without a blanket atomicity promise');

    const active = member(), activeRecord = current(active.actor.fetchId()), activeBinding = World.actorPublicationBinding;
    const resetUser = { sessions: [], revision: 0 };
    const reset = window(() => { World.user = resetUser; });
    assert.equal(reset.deliveries.length, 1); assert.equal(reset.deliveries[0].packet.kind, 'reset');
    assert.equal(reset.deliveries[0].packet.cause, 'reset'); assert.equal(reset.deliveries[0].userAtDelivery, resetUser);
    assert.equal(reset.deliveries[0].bindingAtDelivery, World.actorPublicationBinding);
    assert.notEqual(World.actorPublicationBinding, activeBinding); assert.equal(current(activeRecord.id), null);
    assert.deepEqual(reset.legacyIds, []);
    assert.deepEqual(window(() => active.actor.setLocXYZ({ locX: 84000, locY: 0, locZ: 0 })).deliveries, []);
    const nullable = window(() => { World.user = null; });
    assert.equal(nullable.deliveries.length, 1); assert.equal(nullable.deliveries[0].packet.kind, 'reset');
    assert.equal(nullable.deliveries[0].packet.binding, null); assert.equal(nullable.deliveries[0].userAtDelivery, null);
    assert.equal(World.actorPublicationBinding, null); assert.deepEqual(nullable.legacyIds, []);
    assert.deepEqual(window(() => { World.user = undefined; }).deliveries, []);
    const invalidStart = deliveries.length;
    assert.throws(() => { World.user = 42; }, TypeError);
    assert.equal(World.user, undefined); assert.equal(World.actorPublicationBinding, null);
    assert.equal(deliveries.length, invalidStart); stateConserved();
    observe('object and nullable reset publish after assignment, invalid and same binding stay silent');

    World.user = { sessions: [], revision: 0 };
    let outerNullPacket = null, abaDone = false;
    const afterAba = [], intermediate = { sessions: [], revision: 0 };
    const stopAba = subscribe(packet => {
        if (packet.kind === 'reset' && packet.binding === null && !abaDone) {
            abaDone = true; outerNullPacket = packet; World.user = intermediate; World.user = null;
        }
    });
    const stopAbaLate = subscribe(packet => afterAba.push({ packet, user: World.user, binding: World.actorPublicationBinding }));
    World.user = null;
    assert.equal(abaDone, true); assert(outerNullPacket);
    assert.equal(World.user, null); assert.equal(World.actorPublicationBinding, null);
    assert.equal(afterAba.length, 2);
    assert.equal(afterAba[0].user, intermediate); assert.notEqual(afterAba[0].packet.binding, null);
    assert.equal(afterAba[1].user, null); assert.equal(afterAba[1].packet.binding, null);
    assert.notEqual(afterAba[1].packet, outerNullPacket);
    assert(!afterAba.some(delivery => delivery.packet === outerNullPacket));
    stopAba(); stopAbaLate(); stateConserved();
    observe('nullable ABA retains inner reset and suppresses superseded outer null callbacks');

    assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(observations.length, 10);
    console.log('OBSERVATIONS ' + JSON.stringify(observations));
} finally {
    for (const dispose of disposers.reverse()) dispose();
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
    Object.assign(cleanup, { unsubscribeInvocations: disposers.length, shadowsRestored: restorationChecks.every(check => check()),
        previousWorldRestored: World?.user === previousUser,
        directoryRemoved: !fs.existsSync(directory), pathsAbsent: !fs.existsSync(generated.world) && !fs.existsSync(generated.history),
        workerCreated: false, serverStarted: false });
    const loadedSources = Object.keys(require.cache).filter(filename => filename.startsWith(path.join(gameRoot, 'src') + path.sep))
        .map(filename => ({ path: filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }));
    if (process.env.N62_ACTOR_PUBLICATION_GREEN_EVIDENCE_DIR) fs.writeFileSync(
        path.join(process.env.N62_ACTOR_PUBLICATION_GREEN_EVIDENCE_DIR, 'observations.json'),
        JSON.stringify({ observations, legacyIdCount: legacyIds.length, publicationCount: deliveries.length, cleanup, loadedSources }, null, 2) + '\n');
    console.log('CLEANUP ' + JSON.stringify(cleanup));
}
