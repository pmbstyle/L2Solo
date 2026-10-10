process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
// L23: a restarted cold worker numbers its requests from 1 again (claim:1,
// release:1). The main thread must drop a repeated id only within one worker
// epoch, never the new worker's first requests.
const assert = require('node:assert/strict');
require('../src/Global');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

(async () => {
    const coordinator = new ColdSimulationCoordinator();
    const deliver = async (worker, epoch, msgId) => {
        coordinator.worker = worker;
        coordinator.workerEpoch = epoch;
        await coordinator.onMessage(Protocol.envelope('fault', epoch, { reason: 'restart_ids_fixture' }, msgId), worker, epoch);
    };
    const quiet = utils.infoWarn;
    utils.infoWarn = () => {};
    try {
        const first = {}, second = {};
        await deliver(first, 'cold-worker:test:1', 'claim:1');
        await deliver(first, 'cold-worker:test:1', 'claim:1');
        assert.equal(coordinator.counters.messagesIn, 1);
        assert.equal(coordinator.counters.duplicateMessages, 1, 'the same id from the same worker is a duplicate');

        await deliver(second, 'cold-worker:test:2', 'claim:1');
        assert.equal(coordinator.counters.messagesIn, 2, 'a restarted worker\'s claim:1 is a new message');
        assert.equal(coordinator.counters.duplicateMessages, 1);
        console.log('test_cold_worker_restart_message_ids: ok');
    } finally {
        utils.infoWarn = quiet;
    }
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
