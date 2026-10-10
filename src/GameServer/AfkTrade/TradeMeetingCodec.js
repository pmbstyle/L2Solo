'use strict';
const { canonical } = require('./TradeMeeting');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const shape = (row, length) => Array.isArray(row) && row.length === length;
function encode(input) {
    const row = canonical(input);
    return [1, row.token, row.actorA, row.actorB, row.seqA, row.seqB, row.town,
        [row.point.locX, row.point.locY, row.point.locZ],
        row.parties.map(p => [p.revision, p.sequence, p.phase, p.ownerId, p.leaseId, p.hotAt, p.needRevision,
            [p.route.fee, p.route.scroll, p.route.method, p.route.durationMs], p.survivalCost]),
        row.lines.map(l => [l.payer, l.itemId, l.selfId, l.enchant, l.count, l.price,
            l.adId, l.adRevision, l.needAdId, l.needAdRevision, l.certificate])];
}
function decode(wire) {
    if (!shape(wire, 10) || wire[0] !== 1 || !shape(wire[7], 3) || !shape(wire[8], 2)
        || !wire[8].every(p => shape(p, 9) && shape(p[7], 4)) || !Array.isArray(wire[9])
        || !wire[9].every(l => shape(l, 11))) throw Error('trade_meeting_wire');
    return canonical({ token: wire[1], actorA: wire[2], actorB: wire[3], seqA: wire[4], seqB: wire[5], town: wire[6],
        point: { locX: wire[7][0], locY: wire[7][1], locZ: wire[7][2] },
        parties: wire[8].map(p => ({ revision: p[0], sequence: p[1], phase: p[2], ownerId: p[3], leaseId: p[4],
            hotAt: p[5], needRevision: p[6], route: { fee: p[7][0], scroll: p[7][1], method: p[7][2], durationMs: p[7][3] }, survivalCost: p[8] })),
        lines: wire[9].map(l => ({ payer: l[0], itemId: l[1], selfId: l[2], enchant: l[3], count: l[4], price: l[5],
            adId: l[6], adRevision: l[7], needAdId: l[8], needAdRevision: l[9], certificate: l[10] })) });
}
const PAGE_BYTES = 768, MAX_PAGES = 4, MAX_RAW_BYTES = 8192;
function pages(input) {
    if (input.incoming) return commandPages(input, frame => frame, null, { incoming: input.incoming });
    const wire = encode(input), ref = wire[1], chunks = [];
    let chunk = '';
    const bytes = text => Buffer.byteLength(JSON.stringify([1, ref, chunks.length, MAX_PAGES, text]));
    for (const character of JSON.stringify(wire)) {
        if (bytes(chunk + character) > PAGE_BYTES) {
            if (!chunk || chunks.length >= MAX_PAGES - 1) throw Error('trade_meeting_backpressure');
            chunks.push(chunk); chunk = '';
        }
        chunk += character;
    }
    if (chunk) chunks.push(chunk);
    return chunks.map((text, index) => [1, ref, index, chunks.length, text]);
}
// Transport pages budget the real existing command envelope, including its
// epoch/message identity and collection field. Compression is bounded to one
// canonical basket; no dictionary, extra queue or retained expanded graph.
function dependenciesOf(rows) {
    if (!Array.isArray(rows) || rows.length > 40 || new Set(rows.map(row => row?.[0])).size !== rows.length
        || !rows.every(row => shape(row, 4) && Number.isSafeInteger(row[0]) && row[0] > 0
            && row.slice(1).every(value => typeof value === 'string' && Buffer.byteLength(value) <= 64))) throw Error('trade_meeting_dependencies');
    return rows;
}
function incomingOf(rows) {
    if (!shape(rows, 2) || !rows.every(row => row && typeof row === 'object' && !Array.isArray(row)
        && Object.keys(row).length <= 40 && Object.entries(row).every(([id, count]) => Number.isSafeInteger(Number(id))
            && Number(id) > 0 && String(Number(id)) === id && Number.isSafeInteger(count) && count >= 0))) throw Error('trade_meeting_incoming');
    return rows;
}
function commandPages(input, envelopeFor, dependencies = null, metadata = null) {
    if (typeof envelopeFor !== 'function') throw Error('trade_meeting_envelope');
    const wire = encode(input), ref = wire[1];
    const packed = dependencies === null && metadata === null ? wire : { request: wire,
        ...(dependencies === null ? {} : { dependencies: dependenciesOf(dependencies) }),
        ...(metadata === null ? {} : { incoming: incomingOf(metadata.incoming) }) };
    const raw = Buffer.from(JSON.stringify(packed));
    if (raw.byteLength > MAX_RAW_BYTES) throw Error('trade_meeting_backpressure');
    const text = deflateRawSync(raw).toString('base64');
    const chunks = []; let at = 0;
    while (at < text.length) {
        if (chunks.length >= MAX_PAGES) throw Error('trade_meeting_backpressure');
        let low = 0, high = text.length - at;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            const frame = [2, ref, chunks.length, MAX_PAGES, text.slice(at, at + middle)];
            if (Buffer.byteLength(JSON.stringify(envelopeFor(frame))) <= PAGE_BYTES) low = middle;
            else high = middle - 1;
        }
        if (!low) throw Error('trade_meeting_backpressure');
        chunks.push(text.slice(at, at + low)); at += low;
    }
    return chunks.map((chunk, index) => [2, ref, index, chunks.length, chunk]);
}
function fromPages(frames) {
    if (!Array.isArray(frames) || !frames.length || frames.length > MAX_PAGES * 2) throw Error('trade_meeting_pages');
    const version = frames[0]?.[0], ref = frames[0]?.[1], count = frames[0]?.[3], chunks = new Map();
    if (![1, 2].includes(version)) throw Error('trade_meeting_pages');
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PAGES) throw Error('trade_meeting_pages');
    for (const frame of frames) {
        if (!shape(frame, 5) || frame[0] !== version || frame[1] !== ref || frame[3] !== count
            || !Number.isSafeInteger(frame[2]) || frame[2] < 0 || frame[2] >= count || typeof frame[4] !== 'string'
            || Buffer.byteLength(JSON.stringify(frame)) > PAGE_BYTES) throw Error('trade_meeting_pages');
        if (chunks.has(frame[2]) && chunks.get(frame[2]) !== frame[4]) throw Error('trade_meeting_consent_changed');
        chunks.set(frame[2], frame[4]);
    }
    if (chunks.size !== count) throw Error('trade_meeting_pages_incomplete');
    const text = Array.from({ length: count }, (_, index) => chunks.get(index)).join('');
    let raw = text;
    if (version === 2) {
        const compressed = Buffer.from(text, 'base64');
        if (compressed.toString('base64') !== text) throw Error('trade_meeting_pages');
        raw = inflateRawSync(compressed, { maxOutputLength: MAX_RAW_BYTES }).toString('utf8');
    }
    if (Buffer.byteLength(raw) > MAX_RAW_BYTES) throw Error('trade_meeting_pages');
    const parsed = JSON.parse(raw), decoded = decode(Array.isArray(parsed) ? parsed : parsed.request);
    if (!Array.isArray(parsed)) {
        if (parsed.dependencies !== undefined) decoded.dependencies = dependenciesOf(parsed.dependencies);
        if (parsed.incoming !== undefined) decoded.incoming = incomingOf(parsed.incoming);
    }
    if (decoded.token !== ref) throw Error('trade_meeting_consent_changed');
    return decoded;
}
module.exports = { encode, decode, pages, commandPages, fromPages, PAGE_BYTES, MAX_PAGES, MAX_RAW_BYTES };
