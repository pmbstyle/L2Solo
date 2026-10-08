const assert = require('node:assert/strict');
require('../src/Global');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const coordinator = new ColdSimulationCoordinator();
const messages = [];
const oldWorker = { postMessage: message => messages.push(message) };
coordinator.worker = { postMessage: message => messages.push(message) };
coordinator.workerEpoch = 'current-board-source';
const state = { characterId: 42, phase: 'cold', activity: 'hunting', updatedAt: 10,
    simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 }, timing: {} };
const request = { kind: 'market_review', characterId: 42, commandId: 'old-price-review', state,
    commandCheckpoint: Protocol.commandCheckpoint(state), market: { updates: [], reprices: [], withdrawals: [] } };
(async () => {
    await coordinator.onMessage(Protocol.envelope('command_request', 'retired-board-source', { requests: [request] }),
        oldWorker, 'retired-board-source');
    await coordinator.commandTail;
    assert.equal(messages.length, 0);
    assert.equal(coordinator.commandInflight.size, 0);
    assert.equal(coordinator.executeMarketReviewCommand, undefined);
    assert.equal(Protocol.commandIdentity(request), null);
    console.log('PASS old board command source cannot execute or reply to a replacement worker');
})().catch(error => { console.error(error); process.exitCode = 1; });
