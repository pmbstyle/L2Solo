const PROTOCOL_VERSION = 1;
const MAX_BATCH = 64;
const MAX_MESSAGE_BYTES = 256 * 1024;

const MAIN_TYPES = new Set([
    'init',
    'catalog_page',
    'snapshot_page',
    'worker_presence_request',
    'worker_repair_request',
    'clan_social_page',
    // ColdTableChannel pages: limited by size only, so no batch field below.
    'table_page',
    'claim_ack',
    'lease_renewal',
    'commit_ack',
    'release_ack',
    'command_ack',
    'maintenance_ack',
    'party_formation_request',
    'fence',
    'fence_ack',
    'pause',
    'resume',
    'throttle',
    'competition_release',
    'shutdown'
]);

const WORKER_TYPES = new Set([
    'ready',
    'worker_presence_ack',
    'worker_repair_ack',
    'claim_request',
    'proposal_batch',
    'release_request',
    'command_request',
    'maintenance_request',
    'party_formation_proposal',
    'heartbeat',
    'fence_ack',
    'drained',
    'table_resync',
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

// The JSON size of an envelope whose payload size is already known: the
// envelope with an empty payload ("{}", 2 bytes) plus the payload's size.
function envelopeBytes(message, payloadBytes) {
    return byteLength({ ...message, payload: {} }) - 2 + payloadBytes;
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
    // Serialising a page only to measure it costs as much as building it.
    // A sender that sized the page while building it passes that size, and
    // stamps the measured size on the message so the receiver can skip it.
    const bytes = Number.isFinite(options.bytes) && options.bytes >= 0 ? options.bytes : byteLength(message);
    if (!Number.isFinite(bytes) || bytes > Number(options.maxBytes || MAX_MESSAGE_BYTES)) {
        return { ok: false, reason: 'message_too_large', bytes };
    }

    const batchFields = {
        snapshot_page: 'rows',
        worker_presence_request: 'rows',
        worker_repair_request: 'rows',
        worker_presence_ack: 'results',
        worker_repair_ack: 'results',
        clan_social_page: 'rows',
        catalog_page: 'rows',
        claim_request: 'candidates',
        claim_ack: 'grants',
        lease_renewal: 'renewals',
        proposal_batch: 'proposals',
        commit_ack: 'results',
        release_request: 'releases',
        release_ack: 'results',
        command_request: 'requests',
        command_ack: 'results',
        party_formation_proposal: 'candidates'
    };
    const batchField = batchFields[message.type];
    const batch = batchField ? message.payload[batchField] : null;
    if (batchField && (!Array.isArray(batch) || batch.length > Number(options.maxBatch || MAX_BATCH))) {
        return { ok: false, reason: 'batch_size' };
    }
    if (message.type === 'worker_presence_request' || message.type === 'worker_repair_request') {
        const ids = new Set(), edges = new Set();
        for (const row of batch) {
            const repair = message.type === 'worker_repair_request';
            const checkpoint = safetyCheckpoint(repair ? row?.checkpoint : row);
            if (!checkpoint || ids.has(checkpoint.characterId)
                || (repair && (!['state', 'board'].includes(row.kind)
                    || typeof row.edgeId !== 'string' || !row.edgeId || row.edgeId.length > 200
                    || edges.has(row.edgeId) || !Number.isSafeInteger(row.expectedWorkerVersion)
                    || row.expectedWorkerVersion < 0
                    || (row.kind === 'board' && (!Number.isSafeInteger(row.expectedBoardCoverageVersion)
                        || row.expectedBoardCoverageVersion < 0))))) {
                return { ok: false, reason: 'invalid_safety_row' };
            }
            ids.add(checkpoint.characterId);
            if (repair) edges.add(row.edgeId);
        }
    }
    if (message.type === 'worker_presence_ack' || message.type === 'worker_repair_ack') {
        const safety = message.payload.safety, ids = new Set();
        const version = value => Number.isSafeInteger(value) && value >= 0;
        const reason = value => typeof value === 'string' && value.length > 0;
        const status = value => value && ['covered', 'deferred', 'ineligible', 'uncovered'].includes(value.status)
            && reason(value.reason);
        if (!safety || !['stateRepairs', 'boardRepairs', 'coverageRepairs'].every(key => version(safety[key]))) {
            return { ok: false, reason: 'invalid_safety_totals' };
        }
        for (const result of batch) {
            const checkpoint = safetyCheckpoint(result?.checkpoint);
            const observed = result?.observedCheckpoint;
            const observedCheckpoint = safetyCheckpoint(observed);
            const repair = message.type === 'worker_repair_ack';
            if (!checkpoint || checkpoint.characterId !== result.characterId || ids.has(result.characterId)
                || !version(result.workerVersion) || (observed !== null
                    && (!observedCheckpoint || observedCheckpoint.characterId !== result.characterId))
                || (repair ? !['state', 'board'].includes(result.kind)
                    || typeof result.edgeId !== 'string' || !result.edgeId || result.edgeId.length > 200
                    || !['accepted', 'covered', 'deferred', 'stale', 'ineligible'].includes(result.status)
                    || !reason(result.reason) || !version(result.boardCoverageVersion)
                    : !status(result.normal) || !status(result.board) || !version(result.board.coverageVersion))) {
                return { ok: false, reason: 'invalid_safety_receipt' };
            }
            ids.add(result.characterId);
        }
    }
    return { ok: true, bytes };
}

const CHECKPOINT_FIELDS = ['characterId', 'phase', 'activity', 'simulationOwner', 'simulationRevision',
    'simulationLeaseId', 'simulationLeaseUntil', 'activityStartedAt', 'nextResolveAt',
    'lastResolvedAt', 'lastHotAt', 'updatedAt'];

function safetyCheckpoint(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const nested = value.simulation !== undefined;
    const number = raw => {
        if (raw === undefined || raw === null) return 0;
        if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return NaN;
        const parsed = Number(raw);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : NaN;
    };
    const checkpoint = {
        characterId: number(value.characterId), phase: value.phase, activity: value.activity,
        simulationOwner: (nested ? value.simulation?.ownerId : value.simulationOwner) ?? 'legacy_main',
        simulationRevision: number(nested ? value.simulation?.revision : value.simulationRevision),
        simulationLeaseId: (nested ? value.simulation?.leaseId : value.simulationLeaseId) ?? null,
        simulationLeaseUntil: number(nested ? value.simulation?.leaseUntil : value.simulationLeaseUntil),
        activityStartedAt: number(nested ? value.timing?.activityStartedAt : value.activityStartedAt),
        nextResolveAt: number(nested ? value.timing?.nextResolveAt : value.nextResolveAt),
        lastResolvedAt: number(nested ? value.timing?.lastResolvedAt : value.lastResolvedAt),
        lastHotAt: number(nested ? value.timing?.lastHotAt : value.lastHotAt),
        updatedAt: number(value.updatedAt)
    };
    if (!checkpoint.characterId || typeof checkpoint.phase !== 'string' || !checkpoint.phase
        || typeof checkpoint.activity !== 'string' || !checkpoint.activity
        || typeof checkpoint.simulationOwner !== 'string' || !checkpoint.simulationOwner
        || (checkpoint.simulationLeaseId !== null
            && (typeof checkpoint.simulationLeaseId !== 'string' || !checkpoint.simulationLeaseId))
        || CHECKPOINT_FIELDS.some(key => typeof checkpoint[key] === 'number' && !Number.isFinite(checkpoint[key]))) return null;
    return checkpoint;
}

function sameSafetyCheckpoint(left, right) {
    const a = safetyCheckpoint(left), b = safetyCheckpoint(right);
    return !!a && !!b && CHECKPOINT_FIELDS.every(key => a[key] === b[key]);
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
    envelopeBytes,
    validateEnvelope,
    validateToken,
    safetyCheckpoint,
    sameSafetyCheckpoint,
    byteLength
};
