'use strict';
// Developer telemetry only: guards precede all clocks, payloads and containers.
// Sources are immutable observations, never inputs to economic decisions.
const Config = require('../Population/PopulationConfig');
const { isMainThread } = require('node:worker_threads');
const LIMITS = Object.freeze({ recordBytes: 1024, batch: 16, batchBytes: 16384,
    mainRecords: 256, workerRecords: 64, keys: 256, owners: 16, perSecond: 64,
    layers: 16, durationSamples: 32 });
const NUMBER_FIELDS = ['revision', 'goalRevision', 'item', 'need', 'actual', 'remaining', 'recordId', 'lineId',
    'tripHours', 'tripFees', 'reserveDelta', 'quote', 'spent', 'edges', 'goalApplied', 'nativeId', 'sequence',
    'errandAt', 'decisionSeq', 'activityLeaf', 'inputHash', 'target', 'owned', 'missing', 'requested', 'planned',
    'wallet', 'available', 'budget', 'reserve', 'priorityReserve', 'escrow', 'unitPrice', 'valueHours',
    'moneyPrice', 'cost', 'recipeId', 'npcId', 'durationMs', 'funded', 'before', 'after'];
const TEXT_FIELDS = ['trigger', 'phase', 'reason', 'town', 'source', 'wishKey', 'commandId', 'caller', 'layer', 'outcome'];
function create({ config = Config, capacity = LIMITS.mainRecords, now = Date.now,
    thread = isMainThread ? 'main' : 'worker' } = {}) {
    capacity = Math.min(LIMITS.mainRecords, Math.max(1, capacity));
    let rows = null, bytes = 0, selected = null, explicit = null, selectionKey = null;
    let counters = null, durations = null, transport = null, inFlight = null;
    let seq = 0, second = -1, rate = 0, dropped = 0, written = 0, offered = 0, sent = 0, batches = 0, sentBytes = 0;
    let drops = null;
    const active = () => config.developerDiagnostics === true;
    const detail = () => active() && config.economyDiagnostics === true;
    function count(layer, outcome, reason = 'unknown', amount = 1) {
        if (!active()) return;
        if (!Number.isSafeInteger(amount) || amount <= 0) return;
        counters ||= new Map();
        const key = `${String(layer).slice(0, 32)}:${String(outcome).slice(0, 32)}:${String(reason).slice(0, 48)}`;
        const slot = counters.has(key) || counters.size < LIMITS.keys - 1 ? key : 'overflow';
        counters.set(slot, (counters.get(slot) || 0) + amount);
    }
    function duration(layer, ms) {
        if (!active() || !Number.isFinite(ms) || ms < 0) return;
        durations ||= new Map();
        layer = String(layer).slice(0, 32);
        if (!durations.has(layer) && durations.size >= LIMITS.layers) { count('duration', 'overflow'); return; }
        let row = durations.get(layer);
        if (!row) { row = { count: 0, totalMs: 0, maxMs: 0, next: 0, samples: [] }; durations.set(layer, row); }
        row.count++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
        row.samples[row.next] = ms; row.next = (row.next + 1) % LIMITS.durationSamples;
    }
    function lose(reason, amount = 1) {
        dropped += amount; drops ||= { rate: 0, queue: 0, size: 0, transport: 0, writer: 0, invalid: 0, stop: 0, upstream: 0 };
        drops[reason] += amount;
    }
    function enabled(id) {
        if (!detail() || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return false;
        const key = String(config.economyDiagnosticsBotIds || '').slice(0, 512);
        if (selectionKey !== key) {
            selectionKey = key; selected = new Set(); explicit = key.trim() ? new Set(key.split(',').slice(0, LIMITS.owners)
                .map(Number).filter(value => Number.isSafeInteger(value) && value > 0)) : null;
        }
        id = Number(id);
        if (explicit) return explicit.has(id);
        if (selected.has(id)) return true;
        if (selected.size === LIMITS.owners || ((Math.imul(id, 2654435761) >>> 0) % 64) !== 0) return false;
        selected.add(id); return true;
    }
    function pump() {
        if (!detail() || !transport || inFlight || !rows?.length) return;
        const batch = []; let batchBytes = 512, size = 0;
        while (rows.length && batch.length < LIMITS.batch) {
            const row = rows[0], encoded = Buffer.byteLength(JSON.stringify(row)) + 1;
            if (batchBytes + encoded > LIMITS.batchBytes) break;
            rows.shift(); batch.push(row); batchBytes += encoded; size += Buffer.byteLength(row);
        }
        bytes -= size; inFlight = { id: ++seq, count: batch.length, bytes: size, at: now() };
        batches++; sent += batch.length;
        const message = { id: inFlight.id, records: batch };
        try { const result = transport(message);
            sentBytes += Number.isSafeInteger(result) && result >= 0 ? result : Buffer.byteLength(JSON.stringify(message));
            if (result === false) { lose('transport', batch.length); inFlight = null; }
        } catch { lose('transport', batch.length); inFlight = null; }
    }
    function enqueue(input, imported = false) {
        if (!detail()) return false;
        if (!enabled(input?.owner)) return false;
        offered++;
        const timestamp = now(), bucket = Math.floor(timestamp / 1000);
        if (second !== bucket) { second = bucket; rate = 0; }
        if (rate >= LIMITS.perSecond) { lose('rate'); return false; }
        // Forward the event's original time and thread, never a late main snapshot.
        const record = { v: 1, at: Number.isFinite(input.at) ? input.at : timestamp,
            thread: imported && ['main', 'worker'].includes(input.thread) ? input.thread : thread, owner: Number(input.owner) };
        for (const field of NUMBER_FIELDS) if (Number.isFinite(input[field])) record[field] = input[field];
        for (const field of TEXT_FIELDS) if (typeof input[field] === 'string') record[field] = input[field].slice(0, field === 'wishKey' ? 96 : 64);
        if (Array.isArray(input.candidates)) record.candidates = input.candidates.slice(0, 3)
            .map(row => ({ town: String(row.action || row.town || '').slice(0, 32), hours: Number.isFinite(row.value) ? row.value : null }));
        const row = JSON.stringify(record), size = Buffer.byteLength(row);
        if (size + 1 > LIMITS.recordBytes) { lose('size'); return false; }
        if ((rows?.length || 0) >= capacity || bytes + size > capacity * LIMITS.recordBytes) { lose('queue'); return false; }
        // Every transition is eligible; minute-based owner/phase dedup broke correlation.
        rate++; rows ||= []; rows.push(row); bytes += size; pump(); return true;
    }
    function push(input) { return enqueue(input); }
    function accept(records) {
        if (!detail() || !Array.isArray(records) || records.length > LIMITS.batch) return false;
        if (records.some(row => typeof row !== 'string' || Buffer.byteLength(row) > LIMITS.recordBytes)) return false;
        if (Buffer.byteLength(JSON.stringify({ records })) > LIMITS.batchBytes) return false;
        let accepted = 0;
        for (const row of records) { try { if (enqueue(JSON.parse(row), true)) accepted++; } catch { lose('invalid'); } }
        return accepted;
    }
    function ack(id, amount = 0) {
        if (!detail() || !inFlight || inFlight.id !== id) return false;
        const accepted = Number.isSafeInteger(amount) ? Math.min(inFlight.count, Math.max(0, amount)) : 0;
        written += accepted; if (inFlight.count > accepted) lose('writer', inFlight.count - accepted);
        inFlight = null; pump(); return true;
    }
    function disconnect() { if (inFlight) lose('transport', inFlight.count); inFlight = null; transport = null; }
    function stop() { disconnect(); if (rows?.length) lose('stop', rows.length); rows = null; bytes = 0;
        selected = null; explicit = null; selectionKey = null; counters = null; durations = null; drops = null; }
    function stats() {
        if (!active()) return { enabled: false };
        return { enabled: true, detailEnabled: detail(), queued: rows?.length || 0, bytes, inFlight: inFlight?.count || 0,
            selected: explicit?.size || selected?.size || 0, keys: 0, dropped, acknowledged: written,
            destination: thread === 'main' ? 'history_writer' : 'main_admission',
            ...(thread === 'main' ? { written } : { acceptedByMain: written }), offered, sent, batches, sentBytes,
            oldestAgeMs: rows?.length ? Math.max(0, now() - JSON.parse(rows[0]).at) : 0,
            inFlightAgeMs: inFlight ? Math.max(0, now() - inFlight.at) : 0, drops: drops ? { ...drops } : null };
    }
    function metrics() {
        if (!active()) return { enabled: false };
        return { enabled: true, thread, counts: counters ? Object.fromEntries(counters) : {},
            durations: durations ? Object.fromEntries([...durations].map(([layer, row]) => [layer,
                { count: row.count, totalMs: row.totalMs, maxMs: row.maxMs, samples: row.samples.slice() }])) : {},
            detail: stats() };
    }
    return { active, enabled, push, accept, ack, disconnect, stop, count, duration, metrics, stats,
        noteDropped(amount) { if (active() && Number.isSafeInteger(amount) && amount > 0) lose('upstream', amount); },
        connect(send) { if (!detail()) return false; transport = send; pump(); return true; } };
}
module.exports = { ...create(), create, LIMITS };
