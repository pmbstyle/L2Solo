'use strict';
const Diagnostics = require('./EconomyDiagnostics');
const LIMIT = 17, MAX_BYTES = 1024;
const CAPTURE_BYTES = Symbol('captureBytes');
const POTION_COUNT = Symbol('potionCount');
const KINDS = ['shots', 'potion', 'item_skill'];
function fact(rows, item, before, after, kind = 0) {
    if (!Diagnostics.active() || !rows || !Number.isSafeInteger(before) || !Number.isSafeInteger(after) || before <= after) return;
    if (rows.length >= LIMIT) { Diagnostics.count('consumption_capture', 'dropped', 'fact_limit'); return; }
    if (kind === 1 && (rows[POTION_COUNT] || 0) >= 16) {
        Diagnostics.count('consumption_capture', 'dropped', 'potion_limit'); return;
    }
    const row = [Number(item), before, after, kind];
    const bytes = (rows[CAPTURE_BYTES] || 2) + Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
    if (bytes > MAX_BYTES) {
        Diagnostics.count('consumption_capture', 'dropped', 'byte_limit'); return;
    }
    rows[CAPTURE_BYTES] = bytes;
    rows.push(row);
    if (kind === 1) rows[POTION_COUNT] = (rows[POTION_COUNT] || 0) + 1;
}
function attach(result, rows) { if (Diagnostics.active() && rows?.length) result.consumptionDiagnostics = rows; }
function publish(owner, rows, context = {}) {
    if (!Diagnostics.active() || !Array.isArray(rows) || rows.length > LIMIT) return;
    for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 4 || !row.every(Number.isSafeInteger)
            || row[0] <= 0 || row[1] <= row[2] || row[2] < 0 || !KINDS[row[3]]) continue;
        const [item, before, after, kind] = row, actual = before - after, reason = KINDS[kind];
        Diagnostics.count('consumption', 'debits', reason);
        Diagnostics.count('consumption', 'items', reason, actual);
        if (Diagnostics.enabled(owner)) Diagnostics.push({ owner: Number(owner), phase: 'consumed', item,
            source: context.source || 'cold_commit', before, after, actual, reason,
            commandId: context.commandId, proposalId: context.proposalId, revision: context.revision, sequence: context.sequence });
    }
}
function drop(proposal) {
    if (!Diagnostics.active()) return false;
    const rows = proposal?.result?.consumptionDiagnostics;
    if (!rows) return false;
    delete proposal.result.consumptionDiagnostics;
    Diagnostics.count('consumption_capture', 'dropped', 'ipc_capacity', Math.min(LIMIT, rows.length));
    return true;
}
function hot(session, item, before, after, reason) {
    if (!Diagnostics.active() || !session?.accountId?.startsWith?.('bot_') || before <= after) return;
    const owner = Number(session.actor?.fetchId?.());
    Diagnostics.count('consumption', 'debits', reason);
    Diagnostics.count('consumption', 'items', reason, before - after);
    if (Diagnostics.enabled(owner)) Diagnostics.push({ owner, item, before, after, actual: before - after,
        phase: 'consumed', source: 'hot_inventory', reason, commandId: session.workerCommand?.commandId });
}
module.exports = { fact, attach, publish, drop, hot, LIMIT, MAX_BYTES };
