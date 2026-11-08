'use strict';
// The decision trace (situations.md §13, level 2): one record per situation raised, stop heard, decision taken,
// death (with its killer), worker restart and survived failure, for every bot, while `[BotPopulation] decisionTrace`
// is on (off by default; its own switch: developerDiagnostics keeps the counters and timings). Both threads record:
// the cold worker's records travel to main (`decision_trace` messages, ColdSimulationCoordinator), main's to the
// history thread (HistoryDatabase), whose writer (DecisionTraceWriter) appends them to logs/decision-trace.jsonl and
// drops files past 48 h at the history retention tick. Readers: scripts/trace.js.
// Bounded (limits.md "Decision trace"): a rate and a queue per thread, a record size; a record past them is dropped
// and counted by reason (stats().drops), never silent. detail(): the build's inputs, purchases and funding (the old
// economy journal's phases) for a fixed 1/64 sample of bots (detailed(id)), and only from the rate and queue left
// above the decisions' reserve — temporary until level 3 (a bot followed on demand) replaces the sample per step.
// Off: every entry point returns before a clock, an allocation or a payload.
const Config = require('./Population/PopulationConfig');
const { isMainThread } = require('node:worker_threads');
const LIMITS = Object.freeze({ recordBytes: 1024, batch: 64, batchBytes: 65536, mainRecords: 2048, workerRecords: 1024,
    perSecond: 256, detailShare: 0.25, sample: 64 });
const NUMBER_FIELDS = ['revision', 'goalRevision', 'item', 'need', 'actual', 'remaining', 'recordId', 'lineId',
    'tripHours', 'tripFees', 'reserveDelta', 'quote', 'spent', 'edges', 'goalApplied', 'nativeId', 'sequence',
    'errandAt', 'receiptUnits', 'receiptSpent', 'decisionSeq', 'activityLeaf', 'inputHash', 'target', 'owned', 'missing', 'requested', 'planned',
    'wallet', 'available', 'budget', 'reserve', 'priorityReserve', 'escrow', 'unitPrice', 'valueHours',
    'moneyPrice', 'cost', 'recipeId', 'npcId', 'durationMs', 'funded', 'before', 'after', 'commandKind', 'soft', 'level'];
const TEXT_FIELDS = ['kind', 'name', 'place', 'woke', 'waits', 'decision', 'how', 'answer', 'was', 'killer', 'spot', 'worker', 'site',
    'trigger', 'phase', 'reason', 'town', 'source', 'wishKey', 'commandId', 'caller', 'layer', 'outcome', 'errandKey', 'proposalId',
    'moved', 'gate', 'mask', 'heldFocus', 'freshFocus', 'heldLeaf', 'freshLeaf', 'social', 'party'];
const LONG_TEXT = new Set(['wishKey', 'errandKey', 'site']);

function create({ config = Config, thread = isMainThread ? 'main' : 'worker', now = Date.now } = {}) {
    const capacity = thread === 'main' ? LIMITS.mainRecords : LIMITS.workerRecords;
    // The share of the rate and the queue the detail records may take: the decisions keep the rest.
    const detailRate = Math.floor(LIMITS.perSecond * LIMITS.detailShare), detailQueue = Math.floor(capacity * LIMITS.detailShare);
    let rows = null, bytes = 0, transport = null, inFlight = null, seq = 0, second = -1, rate = 0, detailInSecond = 0;
    let offered = 0, sent = 0, written = 0, batches = 0, dropped = 0, drops = null;
    const on = () => config.decisionTrace === true;
    // The detail sample: the same bots on both threads, no list to carry.
    const detailed = id => on() && Number.isSafeInteger(Number(id)) && Number(id) > 0
        && ((Math.imul(Number(id), 2654435761) >>> 0) % LIMITS.sample) === 0;
    function lose(reason, amount = 1) {
        dropped += amount;
        drops ||= { rate: 0, queue: 0, size: 0, transport: 0, writer: 0, invalid: 0, stop: 0, upstream: 0, admission: 0 };
        drops[reason] += amount;
    }
    function pump() {
        if (!on() || !transport || inFlight || !rows?.length) return;
        const batch = []; let batchBytes = 512, size = 0;
        while (rows.length && batch.length < LIMITS.batch) {
            const row = rows[0], encoded = Buffer.byteLength(row) + 4;
            if (batchBytes + encoded > LIMITS.batchBytes) break;
            rows.shift(); batch.push(row); batchBytes += encoded; size += Buffer.byteLength(row);
        }
        bytes -= size; inFlight = { id: ++seq, count: batch.length };
        try {
            if (transport({ id: inFlight.id, records: batch }) === false) { lose('transport', batch.length); inFlight = null; }
            else { batches++; sent += batch.length; }
        } catch { lose('transport', batch.length); inFlight = null; }
    }
    // input: plain fields (NUMBER_FIELDS, TEXT_FIELDS; bot: the subject, `owner` read as it); imported: a record the
    // worker sent, kept with its own time and thread.
    function enqueue(input, imported = false) {
        if (!on()) return false;
        offered++;
        const detail = input?.kind === 'detail';
        const timestamp = now(), bucket = Math.floor(timestamp / 1000);
        if (second !== bucket) { second = bucket; rate = 0; detailInSecond = 0; }
        if (rate >= LIMITS.perSecond || detail && detailInSecond >= detailRate) { lose('rate'); return false; }
        const record = { v: 2, at: Number.isFinite(input.at) ? input.at : timestamp,
            thread: imported && ['main', 'worker'].includes(input.thread) ? input.thread : thread };
        const bot = Number(input.bot ?? input.owner);
        if (Number.isSafeInteger(bot) && bot > 0) record.bot = bot;
        for (const field of NUMBER_FIELDS) if (Number.isFinite(input[field])) record[field] = input[field];
        for (const field of TEXT_FIELDS) if (typeof input[field] === 'string') record[field] = input[field].slice(0, LONG_TEXT.has(field) ? 96 : 64);
        // A worker record re-enqueued on main carries the mapped shape ({ town, hours }): kept, not mapped again.
        if (Array.isArray(input.candidates)) record.candidates = input.candidates.slice(0, 3)
            .map(row => ({ town: String(row.action || row.town || '').slice(0, 32),
                hours: Number.isFinite(row.value) ? row.value : Number.isFinite(row.hours) ? row.hours : null }));
        const row = JSON.stringify(record), size = Buffer.byteLength(row);
        if (size + 1 > LIMITS.recordBytes) { lose('size'); return false; }
        if ((rows?.length || 0) >= (detail ? capacity - detailQueue : capacity)) { lose('queue'); return false; }
        rate++; if (detail) detailInSecond++;
        rows ||= []; rows.push(row); bytes += size; pump(); return true;
    }
    // A level-2 record: kind raise | stop | decided | death | restart | failure.
    const record = fields => on() && enqueue(fields);
    // A level-3 record of a sampled bot (callers test detailed(id) before building it).
    const detail = fields => on() && enqueue({ ...fields, kind: 'detail' });
    // A worker's batch on main: each record re-enqueued under main's bounds.
    function accept(records) {
        if (!on() || !Array.isArray(records) || records.length > LIMITS.batch) return false;
        if (records.some(row => typeof row !== 'string' || Buffer.byteLength(row) > LIMITS.recordBytes)) return false;
        let accepted = 0;
        for (const row of records) { try { if (enqueue(JSON.parse(row), true)) accepted++; } catch { lose('invalid'); } }
        return accepted;
    }
    function ack(id, amount = 0) {
        if (!on() || !inFlight || inFlight.id !== id) return false;
        const accepted = Number.isSafeInteger(amount) ? Math.min(inFlight.count, Math.max(0, amount)) : 0;
        written += accepted;
        if (inFlight.count > accepted) lose(thread === 'main' ? 'writer' : 'admission', inFlight.count - accepted);
        inFlight = null; pump(); return true;
    }
    function disconnect() { if (inFlight) lose('transport', inFlight.count); inFlight = null; transport = null; }
    function stop() { disconnect(); if (rows?.length) lose('stop', rows.length); rows = null; bytes = 0; }
    function stats() {
        if (!on()) return { enabled: false };
        return { enabled: true, queued: rows?.length || 0, bytes, inFlight: inFlight?.count || 0, offered, sent, batches,
            dropped, [thread === 'main' ? 'written' : 'acceptedByMain']: written, drops: drops ? { ...drops } : null };
    }
    return { on, detailed, record, detail, accept, ack, disconnect, stop, stats,
        noteDropped(amount) { if (on() && Number.isSafeInteger(amount) && amount > 0) lose('upstream', amount); },
        connect(send) { if (!on()) return false; transport = send; pump(); return true; } };
}
module.exports = { ...create(), create, LIMITS };
