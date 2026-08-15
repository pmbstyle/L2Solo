const assert = require('assert');
const EventEmitter = require('events');

require('../src/Global');

const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

class FakeWorker extends EventEmitter {
    static instances = [];

    constructor(workerPath, options) {
        super();
        this.workerPath = workerPath;
        this.options = options;
        this.messages = [];
        this.terminated = false;
        FakeWorker.instances.push(this);
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        this.terminated = true;
        return Promise.resolve(1);
    }
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    const originalRecover = Owner.recoverStartupLeases;
    Owner.recoverStartupLeases = () => Promise.resolve({ affectedRows: 0 });
    try {
        const coordinator = new ColdSimulationCoordinator({ WorkerClass: FakeWorker, workerPath: 'fake-worker.js' });
        coordinator.started = true;
        coordinator.startWorker();
        const first = FakeWorker.instances[0];
        const firstEpoch = coordinator.workerEpoch;
        assert(first, 'coordinator must create one long-lived worker');
        assert.strictEqual(first.options.name, 'l2node-cold-simulation');

        first.emit('exit', 1);
        assert.strictEqual(coordinator.snapshot().workerRestarts, 1);
        await wait(1100);
        const second = FakeWorker.instances[1];
        assert(second, 'unexpected worker exit must restart with bounded backoff');
        assert.notStrictEqual(coordinator.workerEpoch, firstEpoch, 'restart must fence every old-epoch message');

        const beforeBatches = second.messages.length;
        const results = Array.from({ length: 20 }, (_, index) => ({
            ok: true,
            characterId: index + 1,
            state: { characterId: index + 1, stats: { padding: 'x'.repeat(40000) } },
            context: {}
        }));
        const pages = coordinator.postCollections('commit_ack', { results });
        const batchMessages = second.messages.slice(beforeBatches);
        assert(pages > 1, 'large ACK payloads must be split below the IPC envelope limit');
        assert.strictEqual(batchMessages.flatMap((message) => message.payload.results).length, results.length);
        assert(batchMessages.every((message) => Protocol.validateEnvelope(message, 'main', {
            workerEpoch: coordinator.workerEpoch
        }).ok), 'every split ACK page must independently validate');

        await coordinator.onMessage({
            version: 1,
            type: 'heartbeat',
            msgId: 'old-heartbeat',
            workerEpoch: firstEpoch,
            sentAt: Date.now(),
            payload: {}
        });
        assert.strictEqual(coordinator.snapshot().invalidMessages, 1, 'late messages from the crashed epoch must be rejected');

        coordinator.lastHeartbeatAt = Date.now() - 6000;
        coordinator.watchdog();
        assert.strictEqual(second.messages.at(-1).type, 'pause', 'a stale heartbeat must pause new claims');
        coordinator.setPauseReason('commit_queue_high_water', true);
        coordinator.lastHeartbeatAt = Date.now();
        coordinator.watchdog();
        assert.strictEqual(second.messages.at(-1).type, 'pause',
            'heartbeat recovery must not bypass an independent commit-queue pause');
        coordinator.setPauseReason('commit_queue_high_water', false);
        assert.strictEqual(second.messages.at(-1).type, 'resume',
            'worker must resume once every pause reason has cleared');

        coordinator.lastHeartbeatAt = Date.now() - 20000;
        coordinator.watchdog();
        assert.strictEqual(second.terminated, true, 'a dead worker must be terminated so the restart path can recover leases');
        coordinator.stopping = true;
        if (coordinator.restartTimer) clearTimeout(coordinator.restartTimer);
        coordinator.restartTimer = null;
        console.log('Cold worker epoch fencing, watchdog, and restart checks passed');
    } finally {
        Owner.recoverStartupLeases = originalRecover;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
