const assert = require('assert');
require('../src/Global');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

// Actual main producer and envelope pagination; no DB initialization/worker
// listener. Missing authoritative rows and an economy fence are real refusals.
(async () => {
    const now = 1000000, ids = [61, 62, 63], emitted = [], replies = [];
    const kernel = new ColdSimulationKernel({ now: () => now, maxInFlight: 4,
        resolveSolo: () => { throw new Error('a refused party cannot resolve'); },
        emit: (type, payload, msgId) => emitted.push({ type, payload, msgId }) });
    const party = { partyId: 'early-claim-refusal', leaderId: 61, memberIds: ids, nextResolveAt: now };
    const states = ids.map(characterId => ({ characterId, phase: 'cold', activity: 'hunting', partyId: party.partyId,
        stats: {}, timing: { nextResolveAt: now }, simulation: { ownerId: 'legacy_main', revision: 1 } }));
    states.forEach((state, index) => kernel.upsert({ state, context: { party, partyMembers: states,
        isPartyLeader: index === 0, spot: { id: 'spot' } } }));
    kernel.tick();
    const request = emitted.find(message => message.type === 'claim_request');
    assert(request);
    const coordinator = new ColdSimulationCoordinator();
    coordinator.workerEpoch = 'n53-claim-transport';
    coordinator.worker = { postMessage: message => replies.push(message) };
    coordinator.contextIndex = () => ({});
    coordinator.economyBots.add(61);
    assert.strictEqual(Database.isReady(), false);
    assert(ids.every(id => LifeState.cachedState(id) === undefined || LifeState.cachedState(id) === null));
    await coordinator.handleClaimRequest(Protocol.envelope('claim_request', coordinator.workerEpoch, request.payload, request.msgId));
    assert(replies.length);
    assert(replies.every(reply => reply.type === 'claim_ack' && reply.msgId === request.msgId));
    const rejected = replies.flatMap(reply => reply.payload.rejected || []);
    assert.strictEqual(rejected.length, 3);
    assert.strictEqual(rejected.find(row => row.characterId === 61).reason, 'economy_in_progress');
    assert.strictEqual(rejected.find(row => row.characterId === 62).reason, 'missing_state');
    assert(rejected.every(row => row.purpose?.kind === 'party' && row.purpose.partyId === party.partyId),
        'early refusals preserve the exact party purpose on the matching request');
    for (const reply of replies) kernel.onClaimAck(reply.payload, reply.msgId);
    assert.strictEqual(kernel.claiming.size, 0);
    assert.strictEqual(kernel.alarms.size, 0);
    assert.strictEqual(kernel.partyRuns.size, 0, 'all-refused matching party ACK pages abort the group immediately');
    assert.strictEqual(kernel.scheduleTokens.get(61).dueAt, now + 1000);
    assert.strictEqual(emitted.some(message => message.type === 'release_request'), false);
    assert.strictEqual(Database.isReady(), false);
    console.log('N53 actual producer request/purpose correlation and early party refusal: pass');
})().catch(error => { console.error(error); process.exitCode = 1; });
