const PROTOCOL_VERSION = 1;
const MAX_BATCH = 64;
const MAX_MESSAGE_BYTES = 256 * 1024;
const ECONOMY_ROUTE_MAX_BYTES = 1536;

const MAIN_TYPES = new Set([
    'init',
    'catalog_page',
    'snapshot_page',
    'worker_presence_request',
    'worker_repair_request',
    'economy_route_request',
    'clan_social_page',
    // ColdTableChannel pages: limited by size only, so no batch field below.
    'table_page',
    'claim_ack',
    'lease_renewal_probe',
    'lease_renewal',
    'commit_ack',
    'release_ack',
    'command_ack',
    'command_request',
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
    'economy_route_result',
    'claim_request',
    'lease_renewal_candidates',
    'proposal_batch',
    'release_request',
    'command_request',
    'command_ack',
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

function competitionEvent(event, at) {
    return !!event && typeof event === 'object' && !Array.isArray(event)
        && event.at === at && typeof event.key === 'string' && event.key.length > 0
        && typeof event.action === 'string' && event.action.length > 0
        && Number.isSafeInteger(event.actor?.id) && event.actor.id > 0
        && Number.isSafeInteger(event.peer?.id) && event.peer.id > 0;
}

function competitionFrame(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Number.isSafeInteger(value.frameId) && value.frameId > 0
        && Number.isSafeInteger(value.at) && value.at > 0
        && Array.isArray(value.events) && value.events.length <= 160
        && value.events.every(event => competitionEvent(event, value.at));
}

function competitionReceipt(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Number.isSafeInteger(value.frameId) && value.frameId > 0
        && Number.isSafeInteger(value.at) && value.at > 0
        && ['accepted', 'deferred', 'observed', 'expired'].includes(value.status);
}

function exactObject(value, keys) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function routePoint(value) {
    return value === null || exactObject(value, ['locX', 'locY', 'locZ'])
        && ['locX', 'locY', 'locZ'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
}
function routeText(value) { return value === null || typeof value === 'string' && value.length <= 80; }
function economyRouteFrame(value) {
    return exactObject(value, ['activity', 'currentRegion', 'loc', 'inventory', 'stats'])
        && typeof value.activity === 'string' && value.activity.length > 0 && value.activity.length <= 80
        && routeText(value.currentRegion) && routePoint(value.loc)
        && exactObject(value.inventory, ['736']) && exactObject(value.inventory[736], ['amount'])
        && Number.isSafeInteger(value.inventory[736].amount) && value.inventory[736].amount >= 0
        && exactObject(value.stats, ['karma', 'marketReturn', 'travel'])
        && Number.isFinite(value.stats.karma) && value.stats.karma >= 0
        && (value.stats.marketReturn === null || exactObject(value.stats.marketReturn, ['loc'])
            && routePoint(value.stats.marketReturn.loc))
        && (value.stats.travel === null || exactObject(value.stats.travel, ['townName', 'arrivalActivity', 'to'])
            && routeText(value.stats.travel.townName) && routeText(value.stats.travel.arrivalActivity)
            && routePoint(value.stats.travel.to));
}
function economyRoutePayload(payload, result = false) {
    return exactObject(payload, ['characterId', 'requestId', 'key', result ? 'rows' : 'frame'])
        && Number.isSafeInteger(payload.characterId) && payload.characterId > 0
        && Number.isSafeInteger(payload.requestId) && payload.requestId > 0
        && typeof payload.key === 'string' && payload.key.length > 0 && payload.key.length <= 600
        && byteLength(payload) <= ECONOMY_ROUTE_MAX_BYTES
        && (result ? Array.isArray(payload.rows) && (payload.rows.length === 0 || payload.rows.length === 16) && payload.rows.every(row =>
            Array.isArray(row) && row.length === 3 && (row[0] === false ? row[1] === null && row[2] === null
                : row[0] === true && Number.isFinite(row[1]) && row[1] >= 0 && Number.isFinite(row[2]) && row[2] >= 0))
            : economyRouteFrame(payload.frame));
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
    if ((message.type === 'economy_route_request' || message.type === 'economy_route_result')
        && !economyRoutePayload(message.payload, message.type === 'economy_route_result')) {
        return { ok: false, reason: 'invalid_economy_route' };
    }
    const meeting = ['command_request', 'command_ack'].includes(message.type)
        && (message.payload.requests || message.payload.results || []).some(row => row?.kind === 'meeting');
    if (meeting && (byteLength(message) > 768
        || !(message.payload.requests || message.payload.results).every(row => meetingIdentity(row)))) {
        return { ok: false, reason: 'invalid_meeting_command' };
    }
    // Serialising a page only to measure it costs as much as building it.
    // A sender that sized the page while building it passes that size, and
    // stamps the measured size on the message so the receiver can skip it.
    const bytes = Number.isFinite(options.bytes) && options.bytes >= 0 ? options.bytes : byteLength(message);
    if (!Number.isFinite(bytes) || bytes > Number(options.maxBytes || MAX_MESSAGE_BYTES)) {
        return { ok: false, reason: 'message_too_large', bytes };
    }
    if (message.type === 'heartbeat' && message.payload.competition
        && Object.prototype.hasOwnProperty.call(message.payload.competition, 'frame')
        && !competitionFrame(message.payload.competition.frame)) {
        return { ok: false, reason: 'invalid_competition_frame' };
    }
    if (message.type === 'competition_release' && (message.payload.events !== undefined
        && (!Array.isArray(message.payload.events) || message.payload.events.length > 160)
        || message.payload.receipt !== undefined && (!Array.isArray(message.payload.events)
            || !competitionReceipt(message.payload.receipt)))) {
        return { ok: false, reason: 'invalid_competition_receipt' };
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
        lease_renewal_candidates: 'tokens',
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
    if (message.type === 'lease_renewal_probe' && (!Number.isSafeInteger(message.payload.replyBy)
        || message.payload.replyBy <= 0)) return { ok: false, reason: 'invalid_renewal_probe' };
    if (message.type === 'lease_renewal_candidates' || message.type === 'lease_renewal') {
        const payload = message.payload, ids = new Set();
        if (message.type === 'lease_renewal_candidates' && (typeof payload.requestId !== 'string'
            || !payload.requestId || payload.requestId.length > 160 || !Number.isSafeInteger(payload.pageIndex)
            || payload.pageIndex < 0 || typeof payload.done !== 'boolean')) {
            return { ok: false, reason: 'invalid_renewal_page' };
        }
        for (const value of batch) {
            const token = leaseRenewalToken(value);
            if (!token || ids.has(token.characterId) || (message.type === 'lease_renewal' && value.ok !== true)) {
                return { ok: false, reason: 'invalid_renewal_token' };
            }
            ids.add(token.characterId);
        }
    }
    if (message.type === 'commit_ack' || message.type === 'release_ack') {
        const ids = new Set();
        for (const result of batch) {
            const identity = leaseAckIdentity(result, message.type);
            if (!identity || ids.has(result.characterId)) return { ok: false, reason: 'invalid_lease_ack' };
            ids.add(result.characterId);
        }
    }
    if (message.type === 'worker_presence_request' || message.type === 'worker_repair_request') {
        const ids = new Set(), edges = new Set();
        for (const row of batch) {
            const repair = message.type === 'worker_repair_request';
            const checkpoint = safetyCheckpoint(repair ? row?.checkpoint : row);
            if (!checkpoint || ids.has(checkpoint.characterId)
                || (repair && (!['state', 'orphan'].includes(row.kind)
                    || typeof row.edgeId !== 'string' || !row.edgeId || row.edgeId.length > 200
                    || edges.has(row.edgeId) || !Number.isSafeInteger(row.expectedWorkerVersion)
                    || row.expectedWorkerVersion < 0))) {
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
        if (!safety || !['stateRepairs', 'coverageRepairs', 'orphanRepairs'].every(key => version(safety[key]))) {
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
                || (repair ? !['state', 'orphan'].includes(result.kind)
                    || typeof result.edgeId !== 'string' || !result.edgeId || result.edgeId.length > 200
                    || !['accepted', 'covered', 'deferred', 'stale', 'ineligible'].includes(result.status)
                    || !reason(result.reason)
                    : !status(result.normal))) {
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

const COMMAND_CHECKPOINT_FIELDS = CHECKPOINT_FIELDS.filter(key => key !== 'simulationLeaseUntil');

function commandCheckpoint(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // Native snapshots have nested ownership/timing; absent native values use
    // the same conservative defaults as safety snapshots. Flat wire input must
    // carry every typed field and cannot obtain those defaults.
    const flat = Object.prototype.hasOwnProperty.call(value, 'simulationOwner');
    let checkpoint;
    if (flat) {
        if (!COMMAND_CHECKPOINT_FIELDS.every(key => Object.prototype.hasOwnProperty.call(value, key))) return null;
        checkpoint = Object.fromEntries(COMMAND_CHECKPOINT_FIELDS.map(key => [key, value[key]]));
    } else {
        const native = safetyCheckpoint({ ...value, simulation: { ...value.simulation, leaseUntil: 0 } });
        if (!native) return null;
        checkpoint = Object.fromEntries(COMMAND_CHECKPOINT_FIELDS.map(key => [key, native[key]]));
    }
    const integers = ['characterId', 'simulationRevision', 'activityStartedAt', 'nextResolveAt',
        'lastResolvedAt', 'lastHotAt', 'updatedAt'];
    if (!integers.every(key => Number.isSafeInteger(checkpoint[key]) && checkpoint[key] >= 0)
        || checkpoint.characterId === 0
        || !['phase', 'activity', 'simulationOwner'].every(key => typeof checkpoint[key] === 'string' && checkpoint[key])
        || (checkpoint.simulationLeaseId !== null
            && (typeof checkpoint.simulationLeaseId !== 'string' || !checkpoint.simulationLeaseId))) return null;
    return checkpoint;
}

function sameCommandCheckpoint(left, right) {
    const a = commandCheckpoint(left), b = commandCheckpoint(right);
    return !!a && !!b && COMMAND_CHECKPOINT_FIELDS.every(key => a[key] === b[key]);
}

function meetingIdentity(value) {
    if (!value || value.kind !== 'meeting' || !Number.isSafeInteger(value.characterId) || value.characterId <= 0
        || typeof value.commandId !== 'string' || !value.commandId || value.commandId.length > 80) return null;
    if (value.frame !== undefined) {
        const frame = value.frame;
        if (!Array.isArray(frame) || frame.length !== 5 || ![1, 2].includes(frame[0]) || frame[1] !== value.commandId
            || !Number.isSafeInteger(frame[2]) || !Number.isSafeInteger(frame[3]) || frame[3] < 1 || frame[3] > 4
            || frame[2] < 0 || frame[2] >= frame[3] || typeof frame[4] !== 'string') return null;
    } else if (typeof value.ok !== 'boolean' || !Number.isSafeInteger(value.pageIndex)
        || value.pageIndex < -1 || value.pageIndex > 3) return null;
    return { characterId: value.characterId, commandId: value.commandId, kind: 'meeting' };
}
function commandIdentity(value) {
    if (value?.kind === 'meeting') return meetingIdentity(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Number.isSafeInteger(value.characterId) || value.characterId <= 0
        || typeof value.commandId !== 'string' || !value.commandId || value.commandId.length > 160) return null;
    if (!value.commandCheckpoint || !COMMAND_CHECKPOINT_FIELDS.every(key =>
        Object.prototype.hasOwnProperty.call(value.commandCheckpoint, key))) return null;
    const checkpoint = commandCheckpoint(value.commandCheckpoint);
    if (!checkpoint || checkpoint.characterId !== value.characterId || checkpoint.phase !== 'cold'
        || (value.state !== undefined && (!value.state || typeof value.state !== 'object'
            || Array.isArray(value.state) || value.state.characterId !== value.characterId))) return null;
    if (value.kind !== undefined && (value.kind !== 'lifecycle'
        || !value.state || !sameCommandCheckpoint(value.state, checkpoint))) return null;
    return { characterId: value.characterId, commandId: value.commandId, checkpoint };
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

function leaseRenewalToken(token) {
    if (!token || typeof token !== 'object' || Array.isArray(token)
        || !Number.isSafeInteger(token.characterId) || token.characterId <= 0
        || token.ownerId !== 'cold_simulation_owner' || !Number.isSafeInteger(token.revision) || token.revision < 0
        || typeof token.leaseId !== 'string' || !token.leaseId || token.leaseId.length > 200
        || !Number.isSafeInteger(token.leaseUntil) || token.leaseUntil <= 0) return null;
    return { characterId: token.characterId, ownerId: token.ownerId, revision: token.revision,
        leaseId: token.leaseId, leaseUntil: token.leaseUntil };
}

function leaseAckIdentity(result, type) {
    if (!['commit_ack', 'release_ack'].includes(type) || !result || typeof result !== 'object'
        || Array.isArray(result) || typeof result.ok !== 'boolean') return null;
    const token = leaseRenewalToken(result.inputToken);
    const key = type === 'commit_ack' ? result.proposalId : result.releaseRequestId;
    if (!token || result.characterId !== token.characterId || typeof key !== 'string' || !key
        || key.length > (type === 'commit_ack' ? 240 : 160)) return null;
    return { token, key };
}

module.exports = {
    PROTOCOL_VERSION,
    MAX_BATCH,
    MAX_MESSAGE_BYTES,
    ECONOMY_ROUTE_MAX_BYTES,
    economyRouteFrame,
    economyRoutePayload,
    envelope,
    envelopeBytes,
    validateEnvelope,
    validateToken,
    leaseRenewalToken,
    leaseAckIdentity,
    safetyCheckpoint,
    sameSafetyCheckpoint,
    commandCheckpoint,
    sameCommandCheckpoint,
    commandIdentity,
    meetingIdentity,
    byteLength,
    competitionEvent
};
