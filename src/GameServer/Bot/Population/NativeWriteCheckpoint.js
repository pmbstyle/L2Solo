const Protocol = require('./ColdSimulationProtocol');
const { WorkerCommandAdmissionRefusal, checkWorkerCommandAdmission } = require('./WorkerCommandAdmission');

const columns = Object.freeze(['characterId', 'phase', 'activity', 'simulationOwner', 'simulationRevision',
    'simulationLeaseId', 'activityStartedAt', 'nextResolveAt', 'lastResolvedAt', 'lastHotAt', 'updatedAt']);
const timing = ['activityStartedAt', 'nextResolveAt', 'lastResolvedAt', 'lastHotAt'];
const sessions = new WeakMap();
const captures = new WeakMap();
const rows = new WeakMap();
const refuse = () => { throw new WorkerCommandAdmissionRefusal('stale_command'); };

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
    const beforeWrite = () => checkWorkerCommandAdmission({ characterId }, capturedOptions);
    sessions.set(beforeWrite, { characterId, expected: Object.freeze({ ...expected }) });
    return beforeWrite;
}

function capture(beforeWrite, characterId) {
    const session = sessions.get(beforeWrite);
    if (!session) return null;
    if (!Number.isSafeInteger(characterId) || characterId !== session.characterId) refuse();
    const proof = Object.freeze({});
    // Capture the private expected value, never a new SELECT/planned input.
    captures.set(proof, { session, characterId, expected: Object.freeze({ ...session.expected }) });
    return proof;
}

function bindRow(beforeWrite, statement, characterId) {
    const session = sessions.get(beforeWrite);
    if (!session) return;
    if (characterId !== session.characterId || !Array.isArray(statement)
        || typeof statement[0] !== 'string' || !Array.isArray(statement[1]) || statement[1][0] !== characterId) refuse();
    rows.set(statement, { session, characterId, sql: statement[0] });
}

function captureRow(beforeWrite, statement) {
    const session = sessions.get(beforeWrite);
    if (!session) return null;
    const bound = rows.get(statement);
    if (!bound || bound.session !== session) refuse();
    const proof = capture(beforeWrite, bound.characterId);
    captures.get(proof).rowSql = bound.sql;
    checkRow(proof, statement);
    return proof;
}

function checkRow(proof, statement) {
    const captured = captures.get(proof), bound = rows.get(statement);
    if (!captured || !bound || bound.session !== captured.session
        || typeof captured.rowSql !== 'string' || statement[0] !== captured.rowSql
        || !Array.isArray(statement[1]) || statement[1][0] !== captured.characterId) refuse();
}

function checkTarget(proof, characterId) {
    const captured = captures.get(proof);
    if (!captured || !Number.isSafeInteger(characterId) || characterId !== captured.characterId) refuse();
}

function check(proof, row) {
    const captured = captures.get(proof), current = nativePoint(row);
    if (!captured || !current || current.phase !== 'cold' || current.simulationOwner !== 'legacy_main'
        || !Protocol.sameCommandCheckpoint(captured.expected, current)) refuse();
}

// Database calls this only with its same queued successful ROW RETURNING.
// An affected0/foreign result, wire/planned state or later read never advances.
function advance(proof, row) {
    const captured = captures.get(proof), next = nativePoint(row);
    if (!captured || !next || next.characterId !== captured.characterId
        || next.phase !== 'cold' || next.simulationOwner !== 'legacy_main'
        || !Protocol.sameCommandCheckpoint(captured.expected, captured.session.expected)) refuse();
    captured.session.expected = Object.freeze({ ...next });
}

module.exports = { columns, create, capture, bindRow, captureRow, checkRow, checkTarget, check, advance };
