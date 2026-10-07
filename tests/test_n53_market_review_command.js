const assert = require('node:assert/strict');
require('../src/Global');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationKernel } = invoke('GameServer/Bot/Population/ColdSimulationKernel');
const state = { characterId: 42, phase: 'cold', activity: 'hunting', updatedAt: 10,
    simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 },
    timing: { activityStartedAt: 1, nextResolveAt: 20, lastResolvedAt: 5, lastHotAt: 0 } };
const saved = Life.cachedState;
(async () => {
    let reads = 0;
    Life.cachedState = () => { reads++; throw Error('retired command must not read native bot state'); };
    try {
        const coordinator = new ColdSimulationCoordinator();
        const messages = [];
        coordinator.worker = { postMessage: message => messages.push(message) };
        coordinator.workerEpoch = 'retired-board-command';
        coordinator.contextFor = () => { throw Error('retired command cannot build context'); };
        assert.equal(coordinator.executeMarketReviewCommand, undefined);
        const kernel = new ColdSimulationKernel({ resolveSolo: () => ({}) });
        kernel.upsert({ state, context: {} });
        assert.equal(kernel.beginCommand(42, 'market_review'), null);
        const requests = Array.from({ length: 300 }, (_, i) => ({ kind: 'market_review', characterId: 42,
            commandId: `retired:${i}`, state, commandCheckpoint: Protocol.commandCheckpoint(state),
            market: { updates: [], reprices: [], withdrawals: [] } }));
        assert(requests.every(request => Protocol.commandIdentity(request) === null));
        await coordinator.onMessage(Protocol.envelope('command_request', coordinator.workerEpoch, { requests }),
            coordinator.worker, coordinator.workerEpoch);
        await coordinator.commandTail;
        assert.equal(coordinator.commandInflight.size, 0);
        assert.equal(coordinator.counters.commands, 0);
        assert.equal(reads, 0);
        assert(messages.filter(m => m.type === 'command_ack').every(m => m.payload.results.length === 0));
        await kernel.shutdown();
        console.log('PASS retired market command: no handler, admission, native state reads or queued work');
    } finally { Life.cachedState = saved; }
})().catch(error => { console.error(error); process.exitCode = 1; });
