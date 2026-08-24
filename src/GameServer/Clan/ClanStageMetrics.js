const SAMPLE_LIMIT = 256;

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function record(samples, stage, durationMs) {
    if (!(samples instanceof Map) || !stage) return;
    const values = samples.get(String(stage)) || [];
    values.push(Math.max(0, number(durationMs)));
    if (values.length > SAMPLE_LIMIT) values.splice(0, values.length - SAMPLE_LIMIT);
    samples.set(String(stage), values);
}

function percentile(sorted, ratio) {
    if (!sorted.length) return 0;
    const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
    return sorted[Math.min(sorted.length - 1, index)];
}

function stats(values = []) {
    if (!values.length) return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
    const sorted = values.slice().sort((left, right) => left - right);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
        count: sorted.length,
        avgMs: Math.round(total / sorted.length),
        p95Ms: Math.round(percentile(sorted, 0.95)),
        maxMs: Math.round(sorted[sorted.length - 1])
    };
}

function snapshot(samples) {
    if (!(samples instanceof Map)) return {};
    return Object.fromEntries([...samples.entries()].map(([stage, values]) => [stage, stats(values)]));
}

module.exports = { record, snapshot };
