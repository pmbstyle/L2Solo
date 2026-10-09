const Requests = invoke('GameServer/World/Generics/NativeItemRequests');
const families = /^native(?:PartyUi|Finder|Friends|Arena|Status|Drop|Items|Menu)/;
function reset(session, { clearDirection = false } = {}) {
    Requests.cancel(session);
    if (clearDirection && (session.nativeItemsWaypoint || session.playerBoardWaypoint) && session.dataSendToMe) {
        session.dataSendToMe(invoke('GameServer/Network/Response').radarControl(2, 2, 0, 0, 0));
    }
    for (const key of Object.keys(session)) {
        // Capabilities belong to the connection; retain monotonically increasing
        // epochs/revisions so old menu actions cannot match a fresh opening.
        if (families.test(key) && !/(?:Version|Epoch|Revision)$/.test(key)) delete session[key];
    }
    for (const key of ['botFriendsView', 'botStatusName', 'botPartyCatalogState']) delete session[key];
    if (session.playerBoardPreparation?.preparationId) require('../../AfkTrade/TradeMeetingService').discard(session.playerBoardPreparation.preparationId);
    for (const key of Object.keys(session)) if (key.startsWith('playerBoard')) delete session[key];
    session.botStatusRequest = (session.botStatusRequest || 0) + 1;
    session.questWaypoints = new Map();
}
module.exports = { reset };
