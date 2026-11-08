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
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const EconomyCommit = require('../src/GameServer/Bot/Economy/EconomyCommit');
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
// The revision a step starts from: the commit's only fence.
function stepRevision(id) {
    const revision = Life.cachedState(id).simulation.revision;
    assert(Number.isSafeInteger(revision)); return revision;
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
// A commit of a fresh bot whose row holds `rowLeaf` (written as an economy
// command writes it) and whose proposal carries `proposalLeaf`: the row keeps
// its own leaf over the proposal's (EconomyCommit.preserveLeafSql).
async function leafCommit(rowLeaf, proposalLeaf, proposalId) {
    const id = await create(), revision = stepRevision(id), stepState = Life.cachedState(id), at = Date.now();
    if (rowLeaf) await Database.execute(["UPDATE bot_life_state SET statsJson=json_set(COALESCE(statsJson,'{}'),'$.economyCommit',json(?)) WHERE characterId=?",
        [JSON.stringify(rowLeaf), id]]);
    const nextState = { ...stepState, activity: 'hunting', updatedAt: at,
        timing: { ...stepState.timing, lastResolvedAt: at, nextResolveAt: at + 60000 },
        stats: proposalLeaf ? { ...stepState.stats, economyCommit: proposalLeaf } : stepState.stats };
    const proposal = { proposalId, revision, nextState, result: { events: [] }, enqueuedAt: at };
    const [commit] = await Owner.commitBatch([{ revision, nextState, proposal, options: { allowLifecycle: true } }]);
    assert(commit.ok); assert.equal(Life.cachedState(id), commit.cached);
    assert.equal(commit.row.economyCommit, rowLeaf ? JSON.stringify(rowLeaf) : null, 'the row kept its own leaf');
    return { ...commit, proposal, nextState };
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
        // PopulationService's part the commit reads: these hunting rows are ones the near-player scan takes.
        await coordinator.start({ realPlayerSessionsNear: World.realPlayerSessionsNear.bind(World), activationCandidate: () => true });
        await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'actual ready Worker');
        assert(coordinator.worker instanceof Worker);
        const worker = coordinator.worker, post = worker.postMessage.bind(worker);
        worker.postMessage = message => { sent.push(message); return post(message); };
        const id = await create(), original = stepRevision(id);
        const handoff = await Owner.handoffToMain(Life.cachedState(id)); assert(handoff.ok);
        const current = stepRevision(id), currentRow = await row(id);
        assert.notEqual(original, current, 'a handoff moves the revision');
        const stale = (await Owner.commitBatch([{ revision: original, nextState: Life.cachedState(id), options: { allowLifecycle: true } }]))[0];
        assert.equal(stale.ok, false); assert.equal(stale.reason, 'stale_revision');
        assert.deepEqual(await row(id), currentRow);
        const proposal = { proposalId: `${id}:1`, revision: original };
        await coordinator.handleCommitResults([{ ...stale, characterId: id, proposal }]);
        const [ack] = take('commit_ack');
        assert(ack); assert.deepEqual(await row(id), currentRow);
        console.log('Actual ready Worker and stale native commit conserves the current row: PASS');
        assert.equal(ack.ok, false); assert.equal(ack.reason, 'stale_revision');
        assert.equal(ack.proposalId, proposal.proposalId);
        assert.equal(ack.state.simulation.revision, current, 'the refusal carries the row main moved');
        console.log('Main commit echoes the step identity and the moved state: PASS');

        const committed = (await Owner.commitBatch([{ revision: current, nextState: Life.cachedState(id), options: { allowLifecycle: true } }]))[0];
        assert(committed.ok); assert.notEqual(committed.revision, current);
        const currentProposal = { proposalId: `${id}:2`, revision: current };
        await coordinator.handleCommitResults([{ ...committed, characterId: id, proposal: currentProposal },
            { ok: false, characterId: 999999, reason: 'malformed_original', proposal: { revision: null } }]);
        const currentAcks = take('commit_ack');
        assert.equal(currentAcks.length, 1);
        assert.equal(currentAcks[0].proposalId, currentProposal.proposalId);
        assert.equal(currentAcks[0].revision, committed.revision);
        assert.equal(currentAcks[0].state.simulation.revision, committed.revision);
        console.log('Successful native output revision stays separate and malformed sibling cannot poison ACK: PASS');

        // A commit whose afterCommit writes nothing: main's cache stays the
        // commit's own entry, the ack carries the numbers and no state, and the
        // worker's copy built from its proposal matches main's cache on the
        // command checkpoint and the bag, kit and henna revisions.
        const numbersId = await create(), stepState = Life.cachedState(numbersId);
        const numbersRevision = stepRevision(numbersId), at = Date.now(), numbersProposalId = `${numbersId}:${at}`;
        // The worker's bag as a step leaves it, not canonical: a bought sword
        // counted before its physical copy exists and an emptied stack.
        const proposedState = { ...stepState, activity: 'hunting', updatedAt: at,
            timing: { ...stepState.timing, lastResolvedAt: at, nextResolveAt: at + 60000 },
            inventory: { 1: { selfId: 1, name: 'Short Sword', amount: 2, stackable: false, equipped: false, slot: 0,
                instances: [{ id: null, amount: 1, enchant: 0, equipped: false, slot: 0 }] },
            1835: { selfId: 1835, name: 'Soulshot: No Grade', amount: 0, stackable: true } } };
        const numbersKernel = new ColdSimulationKernel({ resolveSolo: () => null, emit: () => true });
        numbersKernel.upsert({ state: stepState });
        numbersKernel.inFlight.set(numbersId, { state: stepState, startedAt: at });
        numbersKernel.dirty.set(numbersId, { proposalId: numbersProposalId, characterId: numbersId, revision: numbersRevision,
            priority: 'P1', enqueuedAt: at, nextState: proposedState, result: { events: [] } });
        numbersKernel.flush(null, true);
        const numbersProposal = { proposalId: numbersProposalId, revision: numbersRevision, nextState: proposedState,
            result: { events: [] }, enqueuedAt: at };
        const [numbersCommit] = await Owner.commitBatch([{ revision: numbersRevision, nextState: proposedState,
            proposal: numbersProposal, options: { allowLifecycle: true } }]);
        assert(numbersCommit.ok);
        assert.equal(Life.cachedState(numbersId), numbersCommit.cached, 'the commit names the cache entry it built');
        await coordinator.afterCommit({ proposal: numbersProposal, revision: numbersRevision, nextState: proposedState }, numbersCommit);
        assert.equal(Life.cachedState(numbersId), numbersCommit.cached, 'an afterCommit that writes nothing keeps the entry');
        const committedResult = { ...numbersCommit, proposal: numbersProposal, nextState: proposedState };
        const ackState = { ...coordinator.ackState };
        await coordinator.handleCommitResults([committedResult]);
        const [numbersAck] = take('commit_ack');
        assert.equal(Object.hasOwn(numbersAck, 'state'), false, 'the ack carries no state');
        assert.deepEqual(coordinator.ackState, { with: ackState.with, without: ackState.without + 1 });
        numbersKernel.onCommitAck({ results: [numbersAck] });
        const workerCopy = numbersKernel.states.get(numbersId).state, mainCopy = Life.cachedState(numbersId);
        assert(Protocol.sameCommandCheckpoint(workerCopy, mainCopy), 'the worker copy passes main\'s command checkpoint');
        assert.deepStrictEqual(workerCopy, mainCopy, 'the worker copy is main\'s cached state, its bag canonical');
        console.log('A commit main did not change acks with numbers only and the worker rebuilds main\'s state: PASS');

        // A bot after its first economy step: the row holds a leaf and the
        // proposal carries the same one. The row kept nothing over it: numbers.
        const leaf = EconomyCommit.completed(EconomyCommit.create(1, 0, {}), { success: true });
        const otherLeaf = EconomyCommit.completed(EconomyCommit.create(1, 1, {}), { success: true });
        const sameLeaf = await leafCommit(leaf, leaf, 'same-leaf-proposal');
        assert.equal(sameLeaf.cached.stats, sameLeaf.nextState.stats, 'the same leaf keeps the proposal\'s stats');
        const leafAckState = { ...coordinator.ackState };
        await coordinator.handleCommitResults([sameLeaf]);
        const [sameLeafAck] = take('commit_ack');
        assert.equal(Object.hasOwn(sameLeafAck, 'state'), false, 'the same leaf acks without the state');
        assert.equal(sameLeafAck.inventoryRevision, sameLeaf.cached.bagRevision);
        assert.deepEqual(coordinator.ackState, { with: leafAckState.with, without: leafAckState.without + 1 });
        console.log('A row and a proposal holding the same economy leaf ack with numbers only: PASS');

        // Each condition failing carries the state: main committed another
        // state, a write replaced the cache entry, the commit read the bag or
        // the stats back from the row, or the row kept an economy leaf other
        // than the proposal's (real commits: a different leaf, the row's leaf
        // where the proposal has none, none where the proposal has one).
        const fails = {
            cleanup: { proposal: { ...numbersProposal, inventoryCleanupForced: true } },
            resolvedOnMain: { proposal: { ...numbersProposal, nextState: undefined } },
            cacheReplaced: { cached: { ...numbersCommit.cached } },
            settled: { settled: true },
            pkDrops: { pkDrops: [{ itemId: 1 }] },
            partyPayment: { partyPayment: true },
            rowReread: { row: { ...numbersCommit.row, statsJson: '{}' } },
            economyLeaf: await leafCommit(leaf, otherLeaf, 'different-leaf-proposal'),
            rowLeaf: await leafCommit(leaf, null, 'row-leaf-proposal'),
            proposalLeaf: await leafCommit(null, leaf, 'proposal-leaf-proposal')
        };
        for (const [name, change] of Object.entries(fails)) {
            await coordinator.handleCommitResults([{ ...committedResult, ...change }]);
            const [ack] = take('commit_ack');
            assert(ack.state, `${name}: the ack carries the state`);
            assert.equal(Object.hasOwn(ack, 'inventoryRevision'), false, `${name}: no numbers`);
        }
        assert.equal(coordinator.ackState.with, ackState.with + Object.keys(fails).length);
        console.log('Each failed numbers condition still carries the state: PASS');

        // A main write to a far row while its worker step is out: the step's
        // commit at its base revision is refused and the main write stays.
        const raceId = await create(), raceBase = stepRevision(raceId), raceAt = Date.now();
        const raceStep = { ...Life.cachedState(raceId), activity: 'hunting', updatedAt: raceAt,
            timing: { ...Life.cachedState(raceId).timing, lastResolvedAt: raceAt, nextResolveAt: raceAt + 60000 } };
        const raceProposal = { proposalId: `${raceId}:${raceAt}`, revision: raceBase, nextState: raceStep,
            result: { events: [] }, enqueuedAt: raceAt };
        const mainWrite = await Life.upsertState(Life.cachedState(raceId), 'main_write_during_step');
        assert(mainWrite.simulation.revision > raceBase, 'a main write moves the far row');
        assert.equal(mainWrite.simulation.revision, (await row(raceId)).simulationRevision, 'the cache takes the moved revision');
        const [raceCommit] = await Owner.commitBatch([{ revision: raceBase, nextState: raceStep, proposal: raceProposal,
            options: { allowLifecycle: true } }]);
        assert.equal(raceCommit.ok, false); assert.equal(raceCommit.reason, 'stale_revision');
        const raceRow = await row(raceId);
        assert.equal(JSON.parse(raceRow.statsJson).lastReason, 'main_write_during_step', 'the main write survives');
        assert.equal(raceRow.activity, 'resting');
        console.log('A main write to a far row refuses the step begun before it: PASS');

        // A proposal without a whole revision is refused before the queue.
        sent.length = 0;
        coordinator.handleProposalBatch({ payload: { proposals: [{ proposalId: `${raceId}:${raceAt + 1}`,
            characterId: raceId, revision: 'x', priority: 'P1', enqueuedAt: raceAt, nextState: raceStep }] } });
        await until(() => sent.some(message => message.type === 'commit_ack'), 'invalid revision ack');
        const [invalidAck] = take('commit_ack');
        assert.equal(invalidAck.ok, false); assert.equal(invalidAck.reason, 'invalid_revision');
        assert.equal(invalidAck.proposalId, `${raceId}:${raceAt + 1}`);
        assert.deepEqual(await row(raceId), raceRow, 'a refused proposal writes nothing');
        console.log('A proposal without a revision is acked invalid_revision: PASS');

        // Hold the real queue flush of the old Worker's step before its native
        // prepare, then replace the actual Worker before the commit and its
        // result reach main's handler. Only Promise delivery is gated.
        const lateId = await create(), nativePrepare = coordinator.prepareProposal;
        let entered = 0, resume;
        const gate = new Promise(resolve => { resume = resolve; });
        coordinator.prepareProposal = async (...args) => {
            entered++; await gate; return nativePrepare.apply(coordinator, args);
        };
        try {
            sent.length = 0;
            const oldEpoch = coordinator.workerEpoch, lateAt = Date.now();
            const refused = () => Object.values(coordinator.refusals.commitRefused).reduce((sum, count) => sum + count, 0);
            const refusedBefore = refused();
            const lateState = { ...Life.cachedState(lateId), updatedAt: lateAt,
                timing: { ...Life.cachedState(lateId).timing, lastResolvedAt: lateAt } };
            const lateBatch = Protocol.envelope('proposal_batch', oldEpoch, { proposals: [{ proposalId: `${lateId}:${lateAt}`,
                characterId: lateId, revision: stepRevision(lateId), priority: 'P0', enqueuedAt: lateAt,
                nextState: lateState, result: { events: [] } }] });
            assert(Protocol.validateEnvelope(lateBatch, 'worker', { workerEpoch: oldEpoch }).ok);
            coordinator.onMessage(lateBatch, worker, oldEpoch);
            await until(() => entered === 1, 'the real queue flush gate');
            await worker.terminate();
            await until(() => coordinator.worker === null, 'actual old Worker exit');
            clearTimeout(coordinator.restartTimer); coordinator.restartTimer = null;
            coordinator.startWorker();
            const replacement = coordinator.worker, replacementPost = replacement.postMessage.bind(replacement);
            replacement.postMessage = message => { sent.push(message); return replacementPost(message); };
            await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'actual replacement Worker bootstrap');
            assert.notEqual(replacement, worker); assert.notEqual(coordinator.workerEpoch, oldEpoch);
            resume(); await coordinator.queue.drain();
            assert.equal(sent.filter(message => message.type === 'commit_ack').length, 0);
            sent.length = 0;
            replacement.postMessage = replacementPost;
            assert.equal(refused(), refusedBefore + 1, 'the old step reached its commit result');
        } finally { resume(); coordinator.prepareProposal = nativePrepare; }
        console.log('Actual Worker replacement during a native commit suppresses the old-source ACK: PASS');
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
