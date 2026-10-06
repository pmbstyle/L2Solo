const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const World = invoke('GameServer/World/World');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const previous = { path: options.default.Database.path, history: options.default.Database.historyPath,
    knowledge: Config.knowledgeErrorsEnabled, world: World.user };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-ack-runtime-'));
let coordinator, sequence = 0;
const sent = [];
async function until(predicate, label) {
    for (let attempt = 0; attempt < 2500; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out: ${label}`);
}
async function create() {
    const name = `AckRuntime${++sequence}`;
    const id = Number((await Database.createCharacter('bot_ack_runtime', { name,
        race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 1, locY: 1, locZ: 0 })).insertId);
    await Life.upsertState({ characterId: id, accountName: 'bot_ack_runtime', name,
        phase: 'cold', activity: 'resting', level: 1, inventory: {}, stats: { classId: 0, generatedCold: true },
        loc: { locX: 1, locY: 1, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: { nextResolveAt: Date.now() + 86400000 } }, 'ack_runtime_fixture');
    return id;
}
async function claim(id) {
    const token = await Owner.claim(Life.cachedState(id), { allowLifecycle: true });
    assert(token.ok); assert(Protocol.leaseRenewalToken(token)); return token;
}
async function row(id) {
    return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
}
function take(type) {
    const messages = sent.filter(message => message.type === type);
    sent.length = 0;
    messages.forEach(message => assert(Protocol.validateEnvelope(message, 'main', { workerEpoch: coordinator.workerEpoch }).ok));
    return messages.flatMap(message => message.payload.results);
}
async function release(token) {
    const request = Protocol.envelope('release_request', coordinator.workerEpoch,
        { releases: [{ token, reason: 'ack_identity_fixture' }] });
    assert(Protocol.validateEnvelope(request, 'worker', { workerEpoch: coordinator.workerEpoch }).ok);
    await coordinator.onMessage(request, coordinator.worker, coordinator.workerEpoch);
    return { request, results: take('release_ack') };
}
(async () => {
    try {
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        Config.knowledgeErrorsEnabled = false;
        await new Promise(resolve => Database.init(resolve));
        invoke('GameServer/DataCache').init();
        await Database.createAccount('bot_ack_runtime', 'fixture');
        await Life.init(); await create();
        World.user = { sessions: [], revision: 0 };
        coordinator = new ColdSimulationCoordinator();
        await coordinator.start({ realPlayerSessionsNear: World.realPlayerSessionsNear.bind(World) });
        await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'actual ready Worker');
        assert(coordinator.worker instanceof Worker);
        const worker = coordinator.worker, post = worker.postMessage.bind(worker);
        worker.postMessage = message => { sent.push(message); return post(message); };
        const id = await create(), original = await claim(id);
        const handoff = await Owner.handoffToMain(Life.cachedState(id)); assert(handoff.ok);
        const current = await claim(id), currentRow = await row(id);
        assert.notEqual(original.leaseId, current.leaseId);
        const stale = await Owner.commit(original, Life.cachedState(id), { allowLifecycle: true });
        assert.equal(stale.ok, false); assert.equal(stale.reason, 'stale_revision');
        assert.deepEqual(await row(id), currentRow);
        const proposal = { proposalId: 'old-native-proposal', token: original };
        await coordinator.handleCommitResults([{ ...stale, characterId: id, proposal }]);
        const [ack] = take('commit_ack');
        assert(ack); assert.deepEqual(await row(id), currentRow);
        console.log('Actual ready Worker and stale native commit/current ownership conservation: PASS');
        assert.deepEqual(ack.inputToken, Protocol.leaseRenewalToken(original), 'commit echoes original input token');
        assert.equal(ack.proposalId, proposal.proposalId);
        console.log('Main commit echoes old original identity independently of latest cached state: PASS');

        const oldRelease = await release(original);
        assert.equal(oldRelease.results.length, 1);
        assert.equal(oldRelease.results[0].ok, false);
        assert.deepEqual(oldRelease.results[0].inputToken, Protocol.leaseRenewalToken(original));
        assert.equal(oldRelease.results[0].releaseRequestId, oldRelease.request.msgId);
        assert.deepEqual(await row(id), currentRow);
        console.log('Native stale release echoes exact request identity and conserves fresh grant: PASS');

        const committed = await Owner.commit(current, Life.cachedState(id), { allowLifecycle: true });
        assert(committed.ok); assert.notEqual(committed.revision, current.revision);
        const currentProposal = { proposalId: 'current-native-proposal', token: current };
        await coordinator.handleCommitResults([{ ...committed, characterId: id, proposal: currentProposal },
            { ok: false, characterId: 999999, reason: 'malformed_original', proposal: { token: null, proposalId: 'malformed' } }]);
        const currentAcks = take('commit_ack');
        assert.equal(currentAcks.length, 1);
        assert.deepEqual(currentAcks[0].inputToken, Protocol.leaseRenewalToken(current));
        assert.equal(currentAcks[0].proposalId, currentProposal.proposalId);
        assert.equal(currentAcks[0].revision, committed.revision);
        assert.equal(currentAcks[0].state.simulation.revision, committed.revision);
        console.log('Successful native output revision stays separate and malformed sibling cannot poison ACK: PASS');

        // Native commit retains its lease at a newer revision. The next
        // request uses that current token, never the old original revision.
        const releaseToken = { ok: true, characterId: id, ...Life.cachedState(id).simulation };
        const activeRelease = await release(releaseToken);
        assert.equal(activeRelease.results.length, 1); assert(activeRelease.results[0].ok);
        assert.deepEqual(activeRelease.results[0].inputToken, Protocol.leaseRenewalToken(releaseToken));
        assert.equal(activeRelease.results[0].releaseRequestId, activeRelease.request.msgId);
        assert.notEqual(activeRelease.results[0].revision, releaseToken.revision);
        assert.equal((await row(id)).simulationLeaseId, null);
        console.log('Successful native release keeps original input/request and newer output authority: PASS');

        // Hold delivery of real native release outcomes, then replace the
        // actual Worker before either main handler resumes. Native recovery
        // remains real; only Promise delivery is gated by the fixture.
        const lateToken = await claim(await create()), nativeRelease = Database.releaseColdSimulationLeases;
        let entered = 0, resume;
        const gate = new Promise(resolve => { resume = resolve; });
        Database.releaseColdSimulationLeases = async (...args) => {
            const results = await nativeRelease.apply(Database, args);
            entered++; await gate; return results;
        };
        try {
            sent.length = 0;
            const oldEpoch = coordinator.workerEpoch;
            const pendingCommit = coordinator.handleCommitResults([{ ok: false, characterId: lateToken.characterId,
                reason: 'prepare_refused', proposal: { proposalId: 'old-source-proposal', token: lateToken } }]);
            const lateRequest = Protocol.envelope('release_request', oldEpoch,
                { releases: [{ token: lateToken, reason: 'old_source' }] });
            const pendingRelease = coordinator.onMessage(lateRequest, worker, oldEpoch);
            await until(() => entered === 2, 'two real native outcome delivery gates');
            await worker.terminate();
            await until(() => coordinator.worker === null, 'actual old Worker exit');
            clearTimeout(coordinator.restartTimer); coordinator.restartTimer = null;
            coordinator.startWorker();
            const replacement = coordinator.worker, replacementPost = replacement.postMessage.bind(replacement);
            replacement.postMessage = message => { sent.push(message); return replacementPost(message); };
            await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'actual replacement Worker bootstrap');
            assert.notEqual(replacement, worker); assert.notEqual(coordinator.workerEpoch, oldEpoch);
            resume(); await Promise.all([pendingCommit, pendingRelease]);
            assert.equal(sent.filter(message => message.type === 'commit_ack').length, 0);
            assert.equal(sent.filter(message => message.type === 'release_ack').length, 0);
            sent.length = 0;
            replacement.postMessage = replacementPost;
        } finally { resume(); Database.releaseColdSimulationLeases = nativeRelease; }
        console.log('Actual Worker replacement during native outcome delivery suppresses both old-source ACKs: PASS');
        worker.postMessage = post;
        console.log('Native main ACK identity runtime tests: PASS');
    } finally {
        await coordinator?.stop(); await Database.close();
        options.default.Database.path = previous.path;
        options.default.Database.historyPath = previous.history;
        Config.knowledgeErrorsEnabled = previous.knowledge;
        World.user = previous.world;
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
