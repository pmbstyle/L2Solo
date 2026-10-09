// Completed C4 tutorial reward. These charge the ordinary NG skills, but
// cannot leave their owner through a sale, trade or ground drop.
const SOULSHOT = 5789;
const SPIRITSHOT = 5790;
function selfIdFor(kind, rank = 'none') {
    if (rank !== 'none') return null;
    return kind === 'soulshot' ? SOULSHOT : kind === 'spiritshot' ? SPIRITSHOT : null;
}
function isRestricted(selfId) {
    return Number(selfId) === SOULSHOT || Number(selfId) === SPIRITSHOT;
}
function grant(kind) {
    const selfId = selfIdFor(kind);
    return selfId ? { selfId, amount: kind === 'soulshot' ? 600 : 300 } : null;
}
module.exports = { SOULSHOT, SPIRITSHOT, selfIdFor, isRestricted, grant };
