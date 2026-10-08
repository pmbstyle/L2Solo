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

function normalize(record, { field = 'items' } = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
    const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const base = { at: number(record.at) };
    if (field === 'sold' && Object.hasOwn(record, 'payout')) base.payout = Math.round(number(record.payout));
    const rows = (Array.isArray(record[field]) ? record[field] : []).flatMap(row => {
        if (!row || typeof row !== 'object') return [];
        const tuple = Array.isArray(row) ? row.slice(0, 3) : field === 'sold'
            ? [row.selfId, row.amount, row.price]
            : [row.selfId, row.amount, row.reason === 'market' ? 1 : 0];
        if (field === 'sold') tuple[2] = Math.round(number(tuple[2]));
        return [tuple];
    });
    return compact(base, rows, { field, marketFirst: field === 'items' });
}

module.exports = { compact, normalize, MAX_ROWS, MAX_BYTES };
