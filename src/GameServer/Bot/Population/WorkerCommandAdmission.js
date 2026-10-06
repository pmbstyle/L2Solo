const Protocol = require('./ColdSimulationProtocol');

const REFUSAL_REASONS = new Set([
    'stale_worker_source', 'coordinator_stopping', 'missing_state',
    'hot_handoff_fenced', 'stale_command'
]);

class WorkerCommandAdmissionRefusal extends Error {
    constructor(reason) {
        super(reason);
        this.code = 'BOT_WORKER_COMMAND_ADMISSION_REFUSED';
    }
}

function checkWorkerCommandAdmission(state, options = {}) {
    try {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new WorkerCommandAdmissionRefusal('invalid_worker_admission');
        }
        if (!Object.prototype.hasOwnProperty.call(options, 'workerAdmission')) return;
        const admission = options.workerAdmission;
        if (!admission || typeof admission !== 'object' || Array.isArray(admission)
            || !['characterId', 'commandId', 'commandCheckpoint', 'check'].every(key =>
                Object.prototype.hasOwnProperty.call(admission, key))
            || !Protocol.commandIdentity(admission)
            || state?.characterId !== admission.characterId || typeof admission.check !== 'function') {
            throw new WorkerCommandAdmissionRefusal('invalid_worker_admission');
        }
        const verdict = admission.check();
        if (verdict === null) return;
        // An asynchronous check never grants entry. Drain a rejected native
        // Promise without awaiting it or letting its eventual result admit.
        if (verdict instanceof Promise) verdict.catch(() => {});
        if (verdict && typeof verdict.then === 'function') {
            throw new WorkerCommandAdmissionRefusal('invalid_worker_admission');
        }
        if (verdict && typeof verdict === 'object' && !Array.isArray(verdict)
            && Object.keys(verdict).length === 1 && REFUSAL_REASONS.has(verdict.reason)) {
            throw new WorkerCommandAdmissionRefusal(verdict.reason);
        }
        throw new WorkerCommandAdmissionRefusal('invalid_worker_admission');
    } catch (error) {
        if (error instanceof WorkerCommandAdmissionRefusal) throw error;
        throw new WorkerCommandAdmissionRefusal('invalid_worker_admission');
    }
}

module.exports = { WorkerCommandAdmissionRefusal, checkWorkerCommandAdmission };
