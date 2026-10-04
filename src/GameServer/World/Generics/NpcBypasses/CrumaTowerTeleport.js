'use strict';

const ServerResponse = invoke('GameServer/Network/Response');
const CrumaTowerTeleports = invoke('GameServer/World/C4CrumaTowerTeleports');
const refuseKarmaTeleport = invoke('GameServer/World/Generics/TeleporterKarmaRefusal');

function showMenu(session) {
    const npc = session?.activeNpcTalk;
    const html = CrumaTowerTeleports.html(npc?.selfId);
    if (!html || !npc?.objectId) return false;

    session.dataSendToMe(ServerResponse.npcHtml(npc.objectId, html));
    session.dataSendToMe(ServerResponse.actionFailed());
    return true;
}

module.exports = function crumaTowerTeleport(session, parts) {
    if (!parts?.[1]) {
        showMenu(session);
        return;
    }

    const actor = session?.actor;
    const destination = CrumaTowerTeleports.destination(
        session?.activeNpcTalk?.selfId,
        parts[1]
    );
    if (!actor || !destination) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return;
    }
    if (refuseKarmaTeleport(session, actor)) return;

    invoke(path.actor).teleportTo(session, actor, destination);
};
