const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const World = invoke('GameServer/World/World');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Writes = invoke('GameServer/Persistence/CharacterWriteQueue');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const previous = { path: options.default.Database.path, history: options.default.Database.historyPath,
    knowledge: Config.knowledgeErrorsEnabled, world: World.user };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-renewal-runtime-'));
let coordinator;
let sequence = 0;
const output = [];
async function create() {
    const name = `RenewalRuntime${++sequence}`;
    const id = Number((await Database.createCharacter('bot_renewal_runtime', { name,
        race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 1, locY: 1, locZ: 0 })).insertId);
    await Life.upsertState({ characterId: id, accountName: 'bot_renewal_runtime', name,
        phase: 'cold', activity: 'resting', level: 1, inventory: {}, stats: { classId: 0, generatedCold: true },
        loc: { locX: 1, locY: 1, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: { nextResolveAt: Date.now() + 86400000 } }, 'renewal_runtime_fixture');
    return id;
}
async function claim() {
    const id = await create();
    const token = await Owner.claim(Life.cachedState(id), { leaseMs: 2000, allowLifecycle: true });
    assert.equal(token.ok, true);
    assert(Protocol.leaseRenewalToken(token));
    return token;
}
async function row(id) {
    return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
}
function page(round, tokens, { pageIndex = round.nextPage, done = true, requestId = round.msgId } = {}) {
    return Protocol.envelope('lease_renewal_candidates', round.epoch, { requestId, pageIndex, done, tokens });
}
function send(message, round) {
    return coordinator.onMessage(message, round.worker, round.epoch);
}
function begin() {
    assert.equal(coordinator.beginLeaseRenewalRound(), true);
    assert(coordinator.leaseRenewalRound);
    return coordinator.leaseRenewalRound;
}
function ack(message) {
    return output.find(value => value.type === 'lease_renewal' && value.msgId === message.msgId);
}
async function flushBarrier(work, onFlush = () => {}) {
    let entered, resume;
    const entry = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    Database.registerCharacterWriteFlush(() => { onFlush(); entered(); return gate; });
    try { await work({ entry, resume }); }
    finally { resume(); Database.registerCharacterWriteFlush(Writes.flushCharacter); }
}
async function until(predicate, label) {
    for (let attempt = 0; attempt < 2500; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out: ${label}`);
}
(async () => {
    try {
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        Config.knowledgeErrorsEnabled = false;
        await new Promise(resolve => Database.init(resolve));
        invoke('GameServer/DataCache').init();
        await Database.createAccount('bot_renewal_runtime', 'fixture');
        await Life.init();
        const id = await create();
        World.user = { sessions: [], revision: 0 };
        coordinator = new ColdSimulationCoordinator();
        await coordinator.start({ realPlayerSessionsNear: World.realPlayerSessionsNear.bind(World) });
        await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'actual native Worker bootstrap');
        assert(coordinator.worker instanceof Worker);
        assert(Life.cachedState(id));
        console.log('Actual disposable native lifecycle and ready Worker positive control: PASS');
        assert.equal(typeof coordinator.beginLeaseRenewalRound, 'function', 'fresh token renewal runtime exists');
        clearInterval(coordinator.renewalTimer);
        coordinator.renewalTimer = null;
        const worker = coordinator.worker, nativePost = worker.postMessage.bind(worker);
        let intercept = false;
        worker.postMessage = message => {
            output.push(message);
            if (intercept && message.type === 'lease_renewal_probe') return;
            return nativePost(message);
        };
        // This is an actual ready Worker, with no accepted claim. Native
        // ownership alone must not be evidence that the Worker still holds it.
        const unaccepted = await claim(), unacceptedBefore = await row(unaccepted.characterId);
        const emptyRound = begin();
        await until(() => coordinator.leaseRenewalRound !== emptyRound, 'actual empty Worker proof');
        assert(output.some(message => message.type === 'lease_renewal' && !message.payload.renewals.length));
        assert.deepEqual(await row(unaccepted.characterId), unacceptedBefore);
        console.log('Actual Worker empty proof leaves unaccepted native grant unchanged: PASS');

        // Remaining cases inject typed candidate pages into the real consumer;
        // actual holder/party producer coverage belongs test_n53_lease_renewal.
        intercept = true;
        const token = await claim(), before = await row(token.characterId), round = begin();
        const request = page(round, [token]);
        assert(Protocol.validateEnvelope(request, 'worker', { workerEpoch: round.epoch }).ok);
        await send(request, round);
        const after = await row(token.characterId);
        assert(after.simulationLeaseUntil > before.simulationLeaseUntil);
        const physicalBefore = { ...before }, physicalAfter = { ...after };
        delete physicalBefore.simulationLeaseUntil;
        delete physicalAfter.simulationLeaseUntil;
        assert.deepEqual(physicalAfter, physicalBefore);
        assert.equal(ack(request).payload.renewals.length, 1);
        assert.equal(coordinator.leaseRenewalRound, null);
        console.log('Typed current final page updates only native deadline and gets exact ACK: PASS');

        const correlated = await claim(), correlatedBefore = await row(correlated.characterId), correlationRound = begin();
        const foreign = page(correlationRound, [correlated], { requestId: 'old-round' });
        const outOfOrder = page(correlationRound, [correlated], { pageIndex: 1 });
        await send(foreign, correlationRound); await send(outOfOrder, correlationRound);
        assert.equal(correlationRound.nextPage, 0);
        assert.equal(ack(foreign), undefined); assert.equal(ack(outOfOrder), undefined);
        assert.deepEqual(await row(correlated.characterId), correlatedBefore);
        await send(page(correlationRound, []), correlationRound);
        console.log('Foreign round and skipped page have no native/ACK effect: PASS');

        const first = await claim(), second = await claim(), secondBefore = await row(second.characterId);
        const asyncRound = begin(), firstRequest = page(asyncRound, [first], { done: false });
        const duplicateIndex = page(asyncRound, [second], { pageIndex: 0 });
        const finalRequest = page(asyncRound, [second], { pageIndex: 1 });
        await flushBarrier(async ({ entry, resume }) => {
            const pending = send(firstRequest, asyncRound); await entry;
            assert.equal(asyncRound.nextPage, 1);
            await send(duplicateIndex, asyncRound);
            const final = send(finalRequest, asyncRound);
            assert.equal(asyncRound.nextPage, 2);
            assert.equal(asyncRound.pendingPages, 2);
            assert.equal(asyncRound.doneSeen, true);
            assert(coordinator.currentLeaseRenewalRound(asyncRound));
            assert.equal(coordinator.beginLeaseRenewalRound(), false);
            resume(); await Promise.all([pending, final]);
        });
        assert.equal(ack(duplicateIndex), undefined);
        assert.equal(ack(firstRequest).payload.renewals.length, 1);
        assert.equal(ack(finalRequest).payload.renewals.length, 1);
        assert((await row(second.characterId)).simulationLeaseUntil > secondBefore.simulationLeaseUntil);
        assert.equal(coordinator.leaseRenewalRound, null);
        console.log('Reservation before await and pending final-page lifetime: PASS');

        const duplicateToken = await claim(), duplicateRound = begin();
        await send(page(duplicateRound, [duplicateToken], { done: false }), duplicateRound);
        const duplicateBefore = await row(duplicateToken.characterId), replay = page(duplicateRound, [duplicateToken]);
        await send(replay, duplicateRound);
        assert.equal(ack(replay), undefined);
        assert.equal(coordinator.leaseRenewalRound, null);
        assert.deepEqual(await row(duplicateToken.characterId), duplicateBefore);
        console.log('Cross-page token repetition cancels without a second deadline write: PASS');

        for (const gateName of ['fencedBots', 'economyBots', 'commandInflight']) {
            const held = await claim(), heldBefore = await row(held.characterId), heldRound = begin();
            const heldRequest = page(heldRound, [held]);
            await flushBarrier(async ({ entry, resume }) => {
                const pending = send(heldRequest, heldRound); await entry;
                if (coordinator[gateName] instanceof Map) coordinator[gateName].set(held.characterId, {});
                else coordinator[gateName].add(held.characterId);
                resume(); await pending;
            });
            coordinator[gateName].delete(held.characterId);
            assert.deepEqual(await row(held.characterId), heldBefore);
            assert.deepEqual(ack(heldRequest).payload.renewals, []);
        }
        console.log('Main fence/economy/command changes during actual native flush reject renewal: PASS');

        const changed = await claim(), changedBefore = await row(changed.characterId), changedRound = begin();
        const changedRequest = page(changedRound, [changed]);
        await flushBarrier(async ({ entry, resume }) => {
            const pending = send(changedRequest, changedRound); await entry;
            const latest = Life.cachedState(changed.characterId);
            Life.acceptSimulationOwnership(changed.characterId, latest.simulation, { ...latest, phase: 'hot' });
            resume(); await pending;
        });
        assert.deepEqual(await row(changed.characterId), changedBefore);
        assert.deepEqual(ack(changedRequest).payload.renewals, []);
        assert.equal(Life.cachedState(changed.characterId).phase, 'hot');
        console.log('Latest cached phase after flush blocks renewal without overwriting cache: PASS');

        const retiring = await claim(), queued = await claim(), retiringBefore = await row(retiring.characterId);
        const queuedBefore = await row(queued.characterId), retiredRound = begin();
        const retiringRequest = page(retiredRound, [retiring], { done: false });
        const queuedRequest = page(retiredRound, [queued], { pageIndex: 1 });
        let flushCalls = 0;
        await flushBarrier(async ({ entry, resume }) => {
            const pending = send(retiringRequest, retiredRound); await entry;
            const final = send(queuedRequest, retiredRound);
            const activeFlight = coordinator.leaseRenewalInFlight;
            coordinator.cancelLeaseRenewalRound();
            assert(activeFlight);
            assert.equal(coordinator.leaseRenewalInFlight, activeFlight);
            assert.equal(coordinator.beginLeaseRenewalRound(), false);
            resume(); await Promise.all([pending, final]);
        }, () => { flushCalls++; });
        assert.equal(flushCalls, 1);
        assert.equal(coordinator.leaseRenewalInFlight, null);
        assert.equal(ack(retiringRequest), undefined); assert.equal(ack(queuedRequest), undefined);
        assert.deepEqual(await row(retiring.characterId), retiringBefore);
        assert.deepEqual(await row(queued.characterId), queuedBefore);
        console.log('Cancellation retains actual native flight and makes queued pages inert: PASS');

        const advancedToken = await claim(), advancedRound = begin(), advancedRequest = page(advancedRound, [advancedToken]);
        const nativeRenew = Database.renewColdSimulationLeases;
        let advanced;
        Database.renewColdSimulationLeases = async (...args) => {
            const results = await nativeRenew.apply(Database, args);
            advanced = await Owner.handoffToMain(Life.cachedState(advancedToken.characterId));
            assert(advanced.ok); return results;
        };
        try { await send(advancedRequest, advancedRound); }
        finally { Database.renewColdSimulationLeases = nativeRenew; }
        assert.deepEqual(ack(advancedRequest).payload.renewals, []);
        assert.equal(Life.cachedState(advancedToken.characterId).simulation.revision, advanced.revision);
        assert.equal((await row(advancedToken.characterId)).simulationRevision, advanced.revision);
        console.log('Native advancement after await is conserved and never acknowledged as an old grant: PASS');

        const expiredRound = begin(), late = page(expiredRound, []);
        expiredRound.replyBy = Date.now() - 1;
        await send(late, expiredRound); assert.equal(ack(late), undefined);
        const freshRound = begin();
        assert.notEqual(freshRound.msgId, expiredRound.msgId);
        const obsolete = page(freshRound, [], { requestId: expiredRound.msgId });
        await send(obsolete, freshRound);
        assert.equal(freshRound.nextPage, 0);
        await send(page(freshRound, []), freshRound);
        console.log('Existing-clock expiry and fresh round identity reject late pages: PASS');
        worker.postMessage = nativePost;
        console.log('Lease renewal native runtime tests: PASS');
    } finally {
        await coordinator?.stop();
        Database.registerCharacterWriteFlush(Writes.flushCharacter);
        await Writes.flushAll();
        await Database.close();
        options.default.Database.path = previous.path;
        options.default.Database.historyPath = previous.history;
        Config.knowledgeErrorsEnabled = previous.knowledge;
        World.user = previous.world;
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
