const ServerResponse = invoke('GameServer/Network/Response');
const Karma = invoke('GameServer/Karma');

// C4 (AltKarmaPlayerCanUseGK=False): a teleporter NPC refuses a character
// with karma once the destination is chosen, before any Adena is taken.
module.exports = function refuseKarmaTeleport(session, actor) {
    if (!Karma.closesTowns(actor?.fetchKarma?.())) return false;
    session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: 'Go away, you\'re not welcome here.' }));
    session.dataSendToMe(ServerResponse.actionFailed());
    return true;
};
