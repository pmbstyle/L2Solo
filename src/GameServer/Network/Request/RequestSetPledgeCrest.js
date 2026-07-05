const ReceivePacket = invoke('Packet/Receive');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function broadcastClanAppearance(clan) {
    ClanService.onlineSessions(clan).forEach((memberSession) => {
        memberSession.dataSendToMe(ServerResponse.userInfo(memberSession.actor));
        memberSession.dataSendToOthers(ServerResponse.charInfo(memberSession.actor), memberSession.actor);
        memberSession.dataSendToOthers(ServerResponse.relationChanged(memberSession.actor), memberSession.actor);
    });
}

function requestSetPledgeCrest(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet.readD();
    const length = Number(packet.data[0]) || 0;
    if (length < 0 || length > ClanService.SMALL_CREST_MAX_BYTES) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    packet.readB(length);

    ClanService.setSmallCrest(session.actor, packet.data[1]).then((result) => {
        if (!result.ok) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        session.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(result.clan));
        broadcastClanAppearance(result.clan);
    });
}

module.exports = requestSetPledgeCrest;
