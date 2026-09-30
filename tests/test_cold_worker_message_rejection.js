const assert = require('assert');
const EventEmitter = require('events');

require('../src/Global');

const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        return Promise.resolve(1);
    }
}

const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

(async () => {
    const originalClaimBatch = Owner.claimBatch;
    // The live failure: a claim transaction met a WAL truncate checkpoint.
    Owner.claimBatch = () => {
        const error = new Error('database is locked');
        error.code = 'ERR_SQLITE_ERROR';
        error.errcode = 5;
        error.coldOwnerRecorded = true;
        return Promise.reject(error);
    };
    try {
        const coordinator = new ColdSimulationCoordinator({ WorkerClass: FakeWorker, workerPath: 'fake-worker.js' });
        const recorded = [];
        coordinator.recordError = (error) => recorded.push(error);
        coordinator.started = true;
        coordinator.startWorker();

        const request = Protocol.envelope('claim_request', coordinator.workerEpoch, { candidates: [] });
        coordinator.worker.emit('message', request);
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepStrictEqual(unhandled, [], 'a failed claim must not become an unhandled rejection');
        assert.strictEqual(recorded.length, 1, 'the failure is recorded as a cold worker error');
        assert.strictEqual(recorded[0].message, 'database is locked');
        assert.strictEqual(coordinator.counters.messagesIn, 1);
    } finally {
        Owner.claimBatch = originalClaimBatch;
    }
    console.log('cold worker message rejection tests passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
