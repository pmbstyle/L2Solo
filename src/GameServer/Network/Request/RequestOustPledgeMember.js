const ReceivePacket = invoke('Packet/Receive');
const World = invoke('GameServer/World/World');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function onlineSessionByName(name) {
    const lookup = String(name || '').toLowerCase();
    return (World.user?.sessions || []).find((session) => session.actor?.fetchName?.().toLowerCase() === lookup);
}

function requestOustPledgeMember(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readS(); // Target name

    consume(session, {
        name: packet.data[0]
    });
}

function consume(session, data) {
    const actor = session.actor;
    const clan = ClanService.clanForActor(actor);
    if (!clan || !ClanService.isLeader(actor, clan)) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const member = clan.members.find((entry) => entry.name.toLowerCase() === String(data.name || '').toLowerCase());
    const targetSession = onlineSessionByName(data.name);
    if (!member || Number(member.id) === Number(actor.fetchId()) || !targetSession?.actor) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    ClanService.removeMember(targetSession.actor, { force: true }).then((result) => {
        targetSession.dataSendToMe(ServerResponse.userInfo(targetSession.actor));
        targetSession.dataSendToMe(ServerResponse.pledgeShowMemberListDelete(member.name));
        ClanService.onlineSessions(result.clan).forEach((memberSession) => {
            memberSession.dataSendToMe(ServerResponse.pledgeShowMemberListDelete(member.name));
            memberSession.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(result.clan));
        });
    }).catch((err) => {
        utils.infoWarn('Clan', 'oust clan member failed: %s', err.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    });
}

module.exports = requestOustPledgeMember;
