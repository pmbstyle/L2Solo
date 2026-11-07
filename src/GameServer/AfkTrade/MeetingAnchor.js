'use strict';

// Where a new trade meeting can take place. An actor with an accepted meeting
// is anchored at it (its earliest accepted one, TradeMeeting.anchor): every
// further deal of that actor meets at the anchor's point, so a deal is
// possible only when each anchored side is anchored in the deal's town and
// both anchors are one point. Our rule, not C4 (C4 has no deferred meetings).
// One rule for the offer choosers (PartyAdmission.personalOfferAllowed: hot,
// cold, main and worker, over the life-state marker) and the native
// preparation (TradeMeetingService.prepareTrade, over the fresh meeting rows).
// A side whose participant row names a meeting that is no longer accepted.
const UNKNOWN = Object.freeze({ unknown: true });
const samePoint = (a, b) => a.town === b.town && ['locX', 'locY', 'locZ'].every(k => a[k] === b[k]);
// The life-state marker stats.tradeMeeting = [meetingId, revision, town, locX, locY, locZ]
// (TradeMeeting.fence writes it; readers of [0]/[1] predate the anchor).
function marker(row) {
    return row ? [row.id, row.revision, row.town, row.locX, row.locY, row.locZ] : null;
}
// TradeMeetingService.init rewrites markers saved before they carried their
// anchor (TradeMeeting.remark), so every marker read here has one.
function fromMarker(value) {
    return Array.isArray(value) ? { town: value[2], locX: value[3], locY: value[4], locZ: value[5] } : null;
}
// A bot's anchor is its life-state marker; a player (no life state) has the
// anchor TradeMeetingService publishes for it (playerAnchor, worker table 'player_anchors').
function of(state, playerAnchor = null) {
    return state ? fromMarker(state.stats?.tradeMeeting) : playerAnchor || null;
}
// anchors: one per side, null when the side has no accepted meeting.
function compatible(town, anchors) {
    let first = null;
    for (const anchor of anchors) {
        if (!anchor) continue;
        if (anchor === UNKNOWN || !town || anchor.town !== town || first && !samePoint(first, anchor)) return false;
        first ||= anchor;
    }
    return true;
}
module.exports = { UNKNOWN, samePoint, marker, fromMarker, of, compatible };
