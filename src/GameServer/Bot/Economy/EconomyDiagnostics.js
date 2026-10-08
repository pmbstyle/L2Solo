'use strict';
// Developer telemetry only. No timer, queue, sample or payload is created
// until enabled. The same bounded buffer serves the main and simulation worker.
const Config = require('../Population/PopulationConfig');
const LIMITS = Object.freeze({ recordBytes: 1024, batch: 16, batchBytes: 16384,
    mainRecords: 256, workerRecords: 64, keys: 64, owners: 16, perSecond: 64 });
const NUMBER_FIELDS = ['revision', 'goalRevision', 'item', 'need', 'actual', 'remaining', 'recordId', 'lineId',
    'tripHours', 'tripFees', 'reserveDelta', 'quote', 'spent', 'edges', 'goalApplied', 'nativeId', 'sequence'];
const TEXT_FIELDS = ['trigger', 'phase', 'reason', 'town', 'source', 'wishKey', 'commandId'];
function create({ config = Config, capacity = LIMITS.mainRecords, now = Date.now } = {}) {
    capacity = Math.min(LIMITS.mainRecords, Math.max(1, capacity));
    let rows = null, bytes = 0, selected = null, explicit = null, selectionKey = null, keys = null;
    let transport = null, inFlight = null, seq = 0, second = -1, rate = 0, dropped = 0, written = 0;
    function enabled(id) {
        if (!config.economyDiagnostics || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return false;
        const key = String(config.economyDiagnosticsBotIds || '').slice(0, 512);
        if (selectionKey !== key) {
            selectionKey = key; selected = new Set(); explicit = key.trim() ? new Set(key.split(',').slice(0, 16)
                .map(Number).filter(value => Number.isSafeInteger(value) && value > 0)) : null;
        }
        id = Number(id);
        if (explicit) return explicit.has(id);
        // Event-based admission; no scan/poll of the population. Eligible IDs
        // are deterministic, the first sixteen observed stay fixed for this run.
        if (selected.has(id)) return true;
        if (selected.size === LIMITS.owners || ((Math.imul(id, 2654435761) >>> 0) % 64) !== 0) return false;
        selected.add(id); return true;
    }
    function pump() {
        if (!config.economyDiagnostics || !transport || inFlight || !rows?.length) return;
        const batch = [];
        while (rows.length && batch.length < LIMITS.batch && Buffer.byteLength(JSON.stringify({ records: [...batch, rows[0]] })) <= LIMITS.batchBytes - 128) batch.push(rows.shift());
        const size = batch.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
        bytes -= size; inFlight = { id: ++seq, count: batch.length, bytes: size };
        try { if (transport({ id: inFlight.id, records: batch }) === false) {
            dropped += batch.length; inFlight = null;
        } } catch { dropped += batch.length; inFlight = null; }
    }
    function push(input) {
        if (!config.economyDiagnostics) return false;
        if (!enabled(input?.owner)) return false;
        const timestamp = now(), bucket = Math.floor(timestamp / 1000);
        if (second !== bucket) { second = bucket; rate = 0; }
        if (rate >= LIMITS.perSecond) { dropped++; return false; }
        const record = { v: 1, at: timestamp, owner: Number(input.owner) };
        for (const field of NUMBER_FIELDS) if (Number.isFinite(input[field])) record[field] = input[field];
        for (const field of TEXT_FIELDS) if (typeof input[field] === 'string') record[field] = input[field].slice(0, field === 'wishKey' ? 96 : 64);
        if (Array.isArray(input.candidates)) record.candidates = input.candidates.slice(0, 3)
            .map(row => ({ town: String(row.action || row.town || '').slice(0, 32), hours: Number.isFinite(row.value) ? row.value : null }));
        const key = `${record.owner}:${record.phase || ''}:${record.reason || ''}`;
        keys ||= new Map();
        if (keys.get(key) === Math.floor(timestamp / 60000)) { dropped++; return false; }
        if (keys.size === LIMITS.keys && !keys.has(key)) keys.delete(keys.keys().next().value);
        const row = JSON.stringify(record), size = Buffer.byteLength(row);
        if (size + 1 > LIMITS.recordBytes || (rows?.length || 0) >= capacity || bytes + size > capacity * LIMITS.recordBytes) {
            dropped++; return false;
        }
        keys.set(key, Math.floor(timestamp / 60000)); rate++; rows ||= []; rows.push(row); bytes += size; pump(); return true;
    }
    function accept(records) {
        if (!config.economyDiagnostics || !Array.isArray(records) || records.length > LIMITS.batch) return false;
        if (records.some(row => typeof row !== 'string' || Buffer.byteLength(row) > LIMITS.recordBytes)) return false;
        if (Buffer.byteLength(JSON.stringify({ records })) > LIMITS.batchBytes) return false;
        for (const row of records) { try { push(JSON.parse(row)); } catch { dropped++; } }
        return true;
    }
    function ack(id, count = 0) {
        if (!inFlight || inFlight.id !== id) return false;
        written += Math.min(inFlight.count, Math.max(0, count)); dropped += inFlight.count - Math.min(inFlight.count, Math.max(0, count));
        inFlight = null; pump(); return true;
    }
    function disconnect() { if (inFlight) dropped += inFlight.count; inFlight = null; transport = null; }
    function stop() { disconnect(); dropped += rows?.length || 0; rows = null; bytes = 0; keys = null; selected = null; selectionKey = null; }
    return { enabled, push, accept, ack, disconnect, stop,
        noteDropped(count) { if (Number.isSafeInteger(count) && count > 0) dropped += count; },
        connect(send) { transport = send; pump(); },
        stats: () => ({ queued: rows?.length || 0, bytes, inFlight: inFlight?.count || 0, selected: explicit?.size || selected?.size || 0, keys: keys?.size || 0, dropped, written }) };
}
module.exports = { ...create(), create, LIMITS };
