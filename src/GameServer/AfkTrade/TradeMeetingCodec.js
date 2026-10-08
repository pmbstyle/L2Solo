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
module.exports = { encode, decode };
