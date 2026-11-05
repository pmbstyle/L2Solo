'use strict';
// Developer counters and timings (developerDiagnostics, the master switch): guards precede all clocks, payloads
// and containers. Sources are immutable observations, never inputs to economic decisions. The record of what a bot
// decided is the decision trace's (Bot/DecisionTrace).
const Config = require('../Population/PopulationConfig');
const { isMainThread } = require('node:worker_threads');
const LIMITS = Object.freeze({ keys: 1024, layers: 32, durationSamples: 32 });
function create({ config = Config, thread = isMainThread ? 'main' : 'worker' } = {}) {
    let counters = null, durations = null;
    // Heartbeat delta bookkeeping (worker thread): keys changed since the last delta that was really sent.
    const dirtyKeys = new Set(), dirtyLayers = new Set();
    let sentSeq = 0, needFull = true, deltaDropped = false;
    const active = () => config.developerDiagnostics === true;
    function count(layer, outcome, reason = 'unknown', amount = 1) {
        if (!active()) return;
        if (!Number.isSafeInteger(amount) || amount <= 0) return;
        counters ||= new Map();
        const key = `${String(layer).slice(0, 32)}:${String(outcome).slice(0, 32)}:${String(reason).slice(0, 48)}`;
        const slot = counters.has(key) || counters.size < LIMITS.keys - 1 ? key : 'overflow';
        counters.set(slot, (counters.get(slot) || 0) + amount);
        dirtyKeys.add(slot);
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
        dirtyLayers.add(layer);
    }
    // Wall time of the consecutive parts of one call: lap(part) closes the part
    // since the previous lap, done() records each part as layer prefix+part.
    // Null while diagnostics are off: no clock read, no allocation.
    function laps(prefix) {
        if (!active()) return null;
        let last = performance.now();
        const spent = {};
        return {
            lap(part) { const at = performance.now(); spent[part] = (spent[part] || 0) + at - last; last = at; },
            done() { for (const part in spent) duration(prefix + part, spent[part]); }
        };
    }
    function omitAggregatesOnOverflow(message, reason) {
        if (!active() || reason !== 'message_too_large' || message?.type !== 'heartbeat'
            || !Object.hasOwn(message.payload || {}, 'developerDiagnostics')) return false;
        delete message.payload.developerDiagnostics;
        deltaDropped = true;
        count('transport', 'aggregate_drop', 'heartbeat_size');
        return true;
    }
    function metrics() {
        if (!active()) return { enabled: false };
        return { enabled: true, thread, counts: counters ? Object.fromEntries(counters) : {},
            durations: durations ? Object.fromEntries([...durations].map(([layer, row]) => [layer, layerRow(row)])) : {} };
    }
    const layerRow = row => ({ count: row.count, totalMs: row.totalMs, maxMs: row.maxMs, samples: row.samples.slice() });
    // The heartbeat form of metrics(): only the keys and layers changed since the last delta that was sent
    // (everything when a full table is due). Clears nothing: deltaSent() does, after the send succeeded.
    function delta() {
        if (!active()) return { enabled: false };
        deltaDropped = false;
        const counts = {}, rows = {};
        const keys = needFull ? (counters?.keys() || []) : dirtyKeys;
        for (const key of keys) counts[key] = counters.get(key);
        const layers = needFull ? (durations?.keys() || []) : dirtyLayers;
        for (const layer of layers) rows[layer] = layerRow(durations.get(layer));
        return { enabled: true, thread, seq: sentSeq + 1, full: needFull, counts, durations: rows };
    }
    function deltaSent() {
        if (deltaDropped) return;
        dirtyKeys.clear(); dirtyLayers.clear(); needFull = false; sentSeq += 1;
    }
    function requestFull() { needFull = true; }
    // Every count and timing dropped (a fixture's fresh start).
    function reset() { counters = null; durations = null; dirtyKeys.clear(); dirtyLayers.clear(); }
    return { active, count, duration, laps, metrics, delta, deltaSent, requestFull, reset, omitAggregatesOnOverflow };
}
module.exports = { ...create(), create, LIMITS };
