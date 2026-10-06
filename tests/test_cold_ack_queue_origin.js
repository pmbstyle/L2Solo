const assert = require('node:assert/strict');
require('../src/Global');
const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdCommitQueue } = require('../src/GameServer/Bot/Population/ColdCommitQueue');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const releaseBatch = Owner.releaseBatch;
let releases = 0;
Owner.releaseBatch = async () => { releases++; return []; };
function proposal(id) {
    const token = { ok: true, characterId: id, ownerId: 'cold_simulation_owner', revision: 1,
        leaseId: `queue-origin-${id}`, leaseUntil: Date.now() + 30000 };
    return { characterId: id, proposalId: `proposal-${id}`, token, priority: 'P2',
        nextState: { characterId: id, phase: 'cold', activity: 'resting', simulation: token } };
}
function control(prepare = async value => value.nextState) {
    const coordinator = new ColdSimulationCoordinator(), sent = [];
    assert(coordinator.queue instanceof ColdCommitQueue);
    coordinator.worker = { name: 'original' }; coordinator.workerEpoch = 'original-epoch';
    coordinator.queue.prepare = prepare;
    coordinator.queue.commit = async entries => entries.map(entry => ({ ok: true,
        characterId: entry.proposal.characterId, revision: entry.token.revision + 1 }));
    coordinator.queue.afterCommit = async () => {};
    coordinator.tableChannel = { flush() {} };
    coordinator.contextIndex = () => ({}); coordinator.contextFor = () => ({});
    coordinator.postCollections = (type, payload) => {
        const message = Protocol.envelope(type, coordinator.workerEpoch, payload);
        assert(Protocol.validateEnvelope(message, 'main', { workerEpoch: coordinator.workerEpoch }).ok);
        sent.push({ worker: coordinator.worker, message }); return 1;
    };
    coordinator.recordError = error => { throw error; };
    return { coordinator, sent };
}
async function ingress(coordinator, values) {
    const message = Protocol.envelope('proposal_batch', coordinator.workerEpoch, { proposals: values });
    assert(Protocol.validateEnvelope(message, 'worker', { workerEpoch: coordinator.workerEpoch }).ok);
    await coordinator.onMessage(message, coordinator.worker, coordinator.workerEpoch);
}
function replace(coordinator) {
    coordinator.worker = { name: 'replacement' }; coordinator.workerEpoch = 'replacement-epoch';
}
async function turn() { await new Promise(resolve => setImmediate(resolve)); }
(async () => {
    try {
        assert.equal(Database.isReady(), false);
        const same = control(), current = proposal(1);
        await ingress(same.coordinator, [current]); await same.coordinator.queue.flushDue(true); await turn();
        assert.equal(same.sent.length, 1); assert.equal(same.sent[0].worker, same.coordinator.worker);
        assert.deepEqual(same.sent[0].message.payload.results[0].inputToken, Protocol.leaseRenewalToken(current.token));
        assert.equal(releases, 0);
        console.log('Actual Coordinator/queue same-source original-token ACK positive: PASS');

        let entered, resume;
        const entry = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { resume = resolve; });
        const held = control(async value => { entered(); await gate; return value.nextState; });
        await ingress(held.coordinator, [proposal(2)]);
        const pending = held.coordinator.queue.flushDue(true); await entry;
        replace(held.coordinator); resume(); await pending; await turn();
        assert.equal(held.sent.length, 0, 'old queued origin cannot acknowledge a replacement');
        console.log('Held actual queue prepare preserves ingress source across replacement: PASS');

        const mixed = control(), old = proposal(3), fresh = proposal(4);
        await ingress(mixed.coordinator, [old]); replace(mixed.coordinator);
        await ingress(mixed.coordinator, [fresh]);
        mixed.coordinator.queue.commit = async entries => entries.map(value => ({
            ok: value.proposal.characterId === fresh.characterId, characterId: value.proposal.characterId,
            reason: value.proposal.characterId === old.characterId ? 'stale_revision' : 'committed', revision: 2 }));
        await mixed.coordinator.queue.flushDue(true); await turn();
        assert.equal(releases, 0, 'obsolete outcome cannot initiate release cleanup');
        assert.equal(mixed.sent.length, 1);
        assert.deepEqual(mixed.sent[0].message.payload.results.map(value => value.characterId), [fresh.characterId]);
        assert.equal(mixed.sent[0].worker, mixed.coordinator.worker);
        console.log('Mixed batch keeps healthy source and skips old cleanup/context/ACK: PASS');

        const moved = control(), body = proposal(5);
        const before = JSON.stringify(body);
        await ingress(moved.coordinator, [body]);
        assert.equal(JSON.stringify(body), before);
        const queued = moved.coordinator.queue.p2.get(body.characterId);
        assert.notEqual(queued, body, 'actual queue shallow clone');
        const wireCopy = { ...queued };
        delete wireCopy.bytes; delete wireCopy.queuedAt;
        assert.equal(JSON.stringify(wireCopy), before);
        // Private origin properties have no transport JSON representation.
        replace(moved.coordinator);
        await moved.coordinator.queue.flushDue(true); await turn();
        assert.equal(moved.sent.length, 0); assert.equal(JSON.stringify(body), before);
        console.log('Actual queue clone retains private origin without changing transport body: PASS');
        assert.equal(Database.isReady(), false);
        console.log('Main queue-origin boundary tests: PASS');
    } finally { Owner.releaseBatch = releaseBatch; }
})().catch(error => { console.error(error); process.exitCode = 1; });
