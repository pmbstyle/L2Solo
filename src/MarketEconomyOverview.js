'use strict';

const HOUR_MS = 60 * 60 * 1000;
const HOURS = 24;

// Read the hourly ledger, never individual transactions. A transfer's two
// stores cancel before classifying an activity as a source or a sink.
function fetch(all, { timestamp = Date.now() } = {}) {
    const current = Math.max(1, Number(timestamp) || Date.now());
    const hour = Math.floor(current / HOUR_MS);
    const from = hour - HOURS + 1;
    const rows = all(`SELECT hour,
        SUM(CASE WHEN net > 0 THEN net ELSE 0 END) AS sources,
        SUM(CASE WHEN net < 0 THEN -net ELSE 0 END) AS sinks,
        SUM(events) AS events
        FROM (
            SELECT hour, operation, SUM(delta) AS net, SUM(events) AS events
            FROM economy_flow_hour WHERE selfId = 57 AND hour >= ? AND hour <= ?
            GROUP BY hour, operation
        ) GROUP BY hour ORDER BY hour`, [from, hour]);
    const byHour = new Map(rows.map((row) => [Number(row.hour), row]));
    return {
        scope: 'saved_hourly_journal',
        generatedAt: current,
        from: from * HOUR_MS,
        to: current,
        buckets: Array.from({ length: HOURS }, (_, index) => {
            const bucketHour = from + index;
            const row = byHour.get(bucketHour);
            const sources = Number(row?.sources || 0);
            const sinks = Number(row?.sinks || 0);
            return { at: bucketHour * HOUR_MS, sources, sinks, net: sources - sinks,
                observed: Number(row?.events || 0) > 0, partial: bucketHour === hour };
        })
    };
}

// The counters already serve the market's decisions; the Observer reads the
// same 24 values. Their index is log(price / first price), not a price in adena.
function counterIndices(counters, timestamp = Date.now()) {
    return counters.COUNTER_KEYS.map((key) => {
        const value = counters.counter(key, timestamp);
        const ratio = value.index === null ? null : Math.exp(Number(value.index));
        const [kind, grade] = key.split(' ');
        return { key, kind, grade, deals: value.deals, buyersPerHour: value.perHour,
            priceIndex: ratio === null ? null : 100 * ratio,
            changePercent: ratio === null ? null : 100 * (ratio - 1) };
    });
}

module.exports = { HOUR_MS, HOURS, fetch, counterIndices };
