const MAX_ROWS = 8, MAX_BYTES = 120;

function compact(base, rows, { marketFirst = false, field = 'items' } = {}) {
    const record = { ...base, [field]: [] };
    const sorted = rows.map(row => row.map(value => Number.isFinite(Number(value)) ? Number(value) : 0))
        .sort((a, b) => (marketFirst ? b[2] - a[2] : 0) || b[1] - a[1]);
    for (const row of sorted.slice(0, MAX_ROWS)) {
        const next = { ...record, [field]: [...record[field], row] };
        if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_BYTES) break;
        record[field].push(row);
    }
    return record;
}

module.exports = { compact, MAX_ROWS, MAX_BYTES };
