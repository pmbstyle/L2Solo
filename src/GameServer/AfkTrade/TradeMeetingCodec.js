'use strict';
const { canonical } = require('./TradeMeeting');
const shape = (row, length) => Array.isArray(row) && row.length === length;
function encode(input) {
    const row = canonical(input);
    return [1, row.token, row.actorA, row.actorB, row.seqA, row.seqB, row.town,
        [row.point.locX, row.point.locY, row.point.locZ],
        row.parties.map(p => [p.revision, p.sequence, p.phase, p.ownerId, p.leaseId, p.hotAt, p.needRevision,
            [p.route.fee, p.route.scroll, p.route.method, p.route.durationMs]]),
        row.lines.map(l => [l.payer, l.itemId, l.selfId, l.enchant, l.count, l.price,
            l.adId, l.adRevision, l.needAdId, l.needAdRevision, l.certificate])];
}
function decode(wire) {
    if (!shape(wire, 10) || wire[0] !== 1 || !shape(wire[7], 3) || !shape(wire[8], 2)
        || !wire[8].every(p => shape(p, 8) && shape(p[7], 4)) || !Array.isArray(wire[9])
        || !wire[9].every(l => shape(l, 11))) throw Error('trade_meeting_wire');
    return canonical({ token: wire[1], actorA: wire[2], actorB: wire[3], seqA: wire[4], seqB: wire[5], town: wire[6],
        point: { locX: wire[7][0], locY: wire[7][1], locZ: wire[7][2] },
        parties: wire[8].map(p => ({ revision: p[0], sequence: p[1], phase: p[2], ownerId: p[3], leaseId: p[4],
            hotAt: p[5], needRevision: p[6], route: { fee: p[7][0], scroll: p[7][1], method: p[7][2], durationMs: p[7][3] } })),
        lines: wire[9].map(l => ({ payer: l[0], itemId: l[1], selfId: l[2], enchant: l[3], count: l[4], price: l[5],
            adId: l[6], adRevision: l[7], needAdId: l[8], needAdRevision: l[9], certificate: l[10] })) });
}
const PAGE_BYTES = 768, MAX_PAGES = 4;
function pages(input) {
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
function fromPages(frames) {
    if (!Array.isArray(frames) || !frames.length || frames.length > MAX_PAGES * 2) throw Error('trade_meeting_pages');
    const ref = frames[0]?.[1], count = frames[0]?.[3], chunks = new Map();
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PAGES) throw Error('trade_meeting_pages');
    for (const frame of frames) {
        if (!shape(frame, 5) || frame[0] !== 1 || frame[1] !== ref || frame[3] !== count
            || !Number.isSafeInteger(frame[2]) || frame[2] < 0 || frame[2] >= count || typeof frame[4] !== 'string'
            || Buffer.byteLength(JSON.stringify(frame)) > PAGE_BYTES) throw Error('trade_meeting_pages');
        if (chunks.has(frame[2]) && chunks.get(frame[2]) !== frame[4]) throw Error('trade_meeting_consent_changed');
        chunks.set(frame[2], frame[4]);
    }
    if (chunks.size !== count) throw Error('trade_meeting_pages_incomplete');
    const decoded = decode(JSON.parse(Array.from({ length: count }, (_, index) => chunks.get(index)).join('')));
    if (decoded.token !== ref) throw Error('trade_meeting_consent_changed');
    return decoded;
}
module.exports = { encode, decode, pages, fromPages, PAGE_BYTES, MAX_PAGES };
