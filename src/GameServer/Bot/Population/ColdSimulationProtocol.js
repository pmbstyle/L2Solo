const PROTOCOL_VERSION = 1;
const MAX_BATCH = 64;
const MAX_MESSAGE_BYTES = 256 * 1024;

const MAIN_TYPES = new Set([
    'init',
    'catalog_page',
    'snapshot_page',
    'claim_ack',
    'lease_renewal',
    'commit_ack',
    'release_ack',
    'command_ack',
    'maintenance_ack',
    'fence',
    'fence_ack',
    'pause',
    'resume',
    'shutdown'
]);

const WORKER_TYPES = new Set([
    'ready',
    'claim_request',
    'proposal_batch',
    'release_request',
    'command_request',
    'maintenance_request',
    'heartbeat',
    'fence_ack',
    'drained',
    'fault'
]);

function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0;
}

function byteLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value));
    } catch (_) {
        return Infinity;
    }
}

function envelope(type, workerEpoch, payload = {}, msgId = null) {
    return {
        version: PROTOCOL_VERSION,
        type,
        msgId: msgId || `${workerEpoch || 'cold'}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        workerEpoch: String(workerEpoch || ''),
        sentAt: Date.now(),
        payload
    };
}

function validateEnvelope(message, direction, options = {}) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return { ok: false, reason: 'invalid_envelope' };
    }
    if (Number(message.version) !== PROTOCOL_VERSION) return { ok: false, reason: 'protocol_version' };
    const allowed = direction === 'main' ? MAIN_TYPES : WORKER_TYPES;
    if (!allowed.has(String(message.type || ''))) return { ok: false, reason: 'message_type' };
    if (!message.msgId || typeof message.msgId !== 'string' || message.msgId.length > 160) {
        return { ok: false, reason: 'message_id' };
    }
    if (!message.workerEpoch || typeof message.workerEpoch !== 'string' || message.workerEpoch.length > 160) {
        return { ok: false, reason: 'worker_epoch' };
    }
    if (options.workerEpoch && message.workerEpoch !== options.workerEpoch) {
        return { ok: false, reason: 'stale_epoch' };
    }
    if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
        return { ok: false, reason: 'invalid_payload' };
    }
    const bytes = byteLength(message);
    if (!Number.isFinite(bytes) || bytes > Number(options.maxBytes || MAX_MESSAGE_BYTES)) {
        return { ok: false, reason: 'message_too_large', bytes };
    }

    const batchFields = {
        snapshot_page: 'rows',
        catalog_page: 'rows',
        claim_request: 'candidates',
        claim_ack: 'grants',
        lease_renewal: 'renewals',
        proposal_batch: 'proposals',
        commit_ack: 'results',
        release_request: 'releases',
        release_ack: 'results',
        command_request: 'requests',
        command_ack: 'results'
    };
    const batchField = batchFields[message.type];
    const batch = batchField ? message.payload[batchField] : null;
    if (batchField && (!Array.isArray(batch) || batch.length > Number(options.maxBatch || MAX_BATCH))) {
        return { ok: false, reason: 'batch_size' };
    }
    return { ok: true, bytes };
}

function validateToken(token = {}) {
    if (!positiveInteger(token.characterId)) return { ok: false, reason: 'invalid_character' };
    if (!Number.isSafeInteger(Number(token.revision)) || Number(token.revision) < 0) {
        return { ok: false, reason: 'invalid_revision' };
    }
    if (!token.leaseId || typeof token.leaseId !== 'string' || token.leaseId.length > 200) {
        return { ok: false, reason: 'invalid_lease' };
    }
    if (!Number.isFinite(Number(token.leaseUntil)) || Number(token.leaseUntil) <= 0) {
        return { ok: false, reason: 'invalid_lease_until' };
    }
    return { ok: true };
}

module.exports = {
    PROTOCOL_VERSION,
    MAX_BATCH,
    MAX_MESSAGE_BYTES,
    envelope,
    validateEnvelope,
    validateToken,
    byteLength
};
