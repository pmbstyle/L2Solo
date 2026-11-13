const Protocol = require('./ColdSimulationProtocol');
const { WorkerCommandAdmissionRefusal, checkWorkerCommandAdmission } = require('./WorkerCommandAdmission');

const columns = Protocol.CHECKPOINT_FIELDS;
const timing = ['activityStartedAt', 'nextResolveAt', 'lastResolvedAt', 'lastHotAt'];
// The bound lifecycle statement is the native 32-column BotLifeState.save ROW (and its revision).
const rowParameters = Object.freeze({ characterId: 0, activity: 10, phase: 11,
    activityStartedAt: 12, nextResolveAt: 13, lastResolvedAt: 14, lastHotAt: 15, updatedAt: 28 });
const sessions = new WeakMap();
const captures = new WeakMap();
const rows = new WeakMap();
const refusalDiagnostics = new WeakMap();
// Failure-only, scalar checkpoint facts. Never retain SQL, stats, inventory or
// the capability itself in a log record, and never replace the original error.
function diagnose(error, stage, captured, current = null) {
    if (!(error instanceof WorkerCommandAdmissionRefusal) || refusalDiagnostics.has(error)) return error;
    const expected = captured?.expected;
    const scalar = value => typeof value === 'string' ? value.slice(0, 160)
        : typeof value === 'number' && Number.isFinite(value) ? value : null;
    const differences = Object.fromEntries(columns.filter(key => expected?.[key] !== current?.[key])
        .map(key => [key, Object.freeze({ expected: scalar(expected?.[key]), current: scalar(current?.[key]) })]));
    refusalDiagnostics.set(error, Object.freeze({ admissionStage: stage,
        characterId: captured?.characterId ?? null, commandId: captured?.session?.commandId ?? captured?.commandId ?? null,
        checkpointDifferences: current ? Object.freeze(differences) : null }));
    return error;
}
const refuse = (stage, captured, current) => {
    throw diagnose(new WorkerCommandAdmissionRefusal('stale_command'), stage || 'invalid_checkpoint', captured, current);
};

function nativePoint(row) {
    if (!row || !columns.every(key => Object.prototype.hasOwnProperty.call(row, key))) return null;
    const value = Object.fromEntries(columns.map(key => [key, row[key]]));
    for (const key of timing) if (value[key] === null) value[key] = 0;
    return Protocol.commandCheckpoint(value);
}

function create(characterId, options) {
    const capturedOptions = Object.freeze({ workerAdmission: options?.workerAdmission });
    checkWorkerCommandAdmission({ characterId }, capturedOptions);
    const expected = Protocol.commandCheckpoint(capturedOptions.workerAdmission?.commandCheckpoint);
    if (!expected || expected.characterId !== characterId) refuse();
    const session = { characterId, commandId: capturedOptions.workerAdmission.commandId,
        expected: Object.freeze({ ...expected }) };
    const beforeWrite = () => {
        try { checkWorkerCommandAdmission({ characterId }, capturedOptions); }
        catch (error) { throw diagnose(error, 'worker_admission', session); }
    };
    sessions.set(beforeWrite, session);
    return beforeWrite;
}

function capture(beforeWrite, characterId) {
    const session = sessions.get(beforeWrite);
    if (!session) return null;
    if (!Number.isSafeInteger(characterId) || characterId !== session.characterId) refuse('capture_target', session);
    const proof = Object.freeze({});
    // Capture the private expected value, never a new SELECT/planned input.
    captures.set(proof, { session, characterId, expected: Object.freeze({ ...session.expected }) });
    return proof;
}

function bindRow(beforeWrite, statement, characterId) {
    const session = sessions.get(beforeWrite);
    if (!session) return;
    if (characterId !== session.characterId || !Array.isArray(statement)
        || typeof statement[0] !== 'string' || !Array.isArray(statement[1]) || statement[1][0] !== characterId) refuse('row_binding', session);
    rows.set(statement, { session, characterId, sql: statement[0] });
}

function captureRow(beforeWrite, statement) {
    const session = sessions.get(beforeWrite);
    if (!session) return null;
    const bound = rows.get(statement);
    if (!bound || bound.session !== session) refuse('row_binding', session);
    const proof = capture(beforeWrite, bound.characterId);
    captures.get(proof).rowSql = bound.sql;
    checkRow(proof, statement);
    return proof;
}

function checkRow(proof, statement) {
    const captured = captures.get(proof), bound = rows.get(statement);
    if (!captured || !bound || bound.session !== captured.session
        || typeof captured.rowSql !== 'string' || statement[0] !== captured.rowSql
        || !Array.isArray(statement[1]) || statement[1][0] !== captured.characterId) refuse('row_binding', captured);
    // ARCH-NOTE: Reject malformed outgoing scalar checkpoints BEFORE the SQL ROW,
    // including mutations while queued. A post-write advance cannot undo autocommit.
    const proposed = { ...captured.expected };
    for (const [key, index] of Object.entries(rowParameters)) proposed[key] = statement[1][index];
    const next = nativePoint(proposed);
    if (!next || next.phase !== 'cold') refuse('outgoing_checkpoint', captured, proposed);
}

function checkTarget(proof, characterId) {
    const captured = captures.get(proof);
    if (!captured || !Number.isSafeInteger(characterId) || characterId !== captured.characterId) refuse('write_target', captured);
}

function check(proof, row) {
    const captured = captures.get(proof), current = nativePoint(row);
    if (!captured || !current || current.phase !== 'cold'
        || !Protocol.sameCommandCheckpoint(captured.expected, current)) refuseDrift(captured, current, row);
}

// Failure-only detail: the checkpoint fields the row moved past the command's
// copy, as the diagnostic's differences (the save failure log) and as
// `checkpointDrift`, the names the caller reloads. A fence moves only the
// revision and updatedAt; a real state change also moves activity or the clocks.
function refuseDrift(captured, current, row) {
    const error = diagnose(new WorkerCommandAdmissionRefusal('stale_command'), 'native_checkpoint', captured, current || row);
    const differences = refusalDiagnostics.get(error)?.checkpointDifferences;
    if (captured && current && differences) error.checkpointDrift = Object.keys(differences);
    throw error;
}

// Database calls this only with its same queued successful ROW RETURNING.
// An affected0/foreign result, wire/planned state or later read never advances.
function advance(proof, row) {
    const captured = captures.get(proof), next = nativePoint(row);
    if (!captured || !next || next.characterId !== captured.characterId
        || next.phase !== 'cold'
        || !Protocol.sameCommandCheckpoint(captured.expected, captured.session.expected)) refuse('advance_checkpoint', captured, next);
    captured.session.expected = Object.freeze({ ...next });
}

module.exports = { columns, create, capture, bindRow, captureRow, checkRow, checkTarget, check, advance,
    refusalDiagnostic: error => refusalDiagnostics.get(error) || null };
