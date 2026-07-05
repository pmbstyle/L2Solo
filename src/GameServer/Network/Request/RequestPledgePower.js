const ReceivePacket = invoke('Packet/Receive');
const World = invoke('GameServer/World/World');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function onlineSessionByActorId(id) {
    return (World.user?.sessions || []).find((session) => Number(session.actor?.fetchId?.()) === Number(id));
}

function requestPledgePower(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()
        .readD();

    if (packet.data[1] === 3) {
        packet.readD();
    }

    consume(session, {
        memberId: packet.data[0],
        action: packet.data[1],
        privileges: packet.data[2] || 0
    });
}

function consume(session, data) {
    const clan = ClanService.clanForActor(session.actor);
    if (!clan) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    if (data.action === 1) {
        session.dataSendToMe(ServerResponse.managePledgePower(session.actor.fetchClanPrivileges()));
        return;
    }

    const targetSession = onlineSessionByActorId(data.memberId);
    if (data.action === 2 && targetSession?.actor) {
        session.dataSendToMe(ServerResponse.managePledgePower(targetSession.actor.fetchClanPrivileges()));
        return;
    }

    if (data.action === 3 && targetSession?.actor) {
        ClanService.setPrivileges(session.actor, targetSession.actor, data.privileges).then((result) => {
            if (!result.ok) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }
            targetSession.dataSendToMe(ServerResponse.userInfo(targetSession.actor));
            targetSession.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(clan));
        });
        return;
    }

    session.dataSendToMe(ServerResponse.actionFailed());
}

module.exports = requestPledgePower;
