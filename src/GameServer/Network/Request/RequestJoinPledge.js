const ReceivePacket = invoke('Packet/Receive');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanInviteService = invoke('GameServer/Clan/ClanInviteService');
const ServerResponse = invoke('GameServer/Network/Response');

function requestJoinPledge(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD(); // Target object id

    consume(session, {
        targetId: packet.data[0]
    });
}

function consume(session, data) {
    const targetSession = ClanService.onlineSessionByActorId(data.targetId);
    const target = targetSession?.actor;
    const allowed = ClanService.canInvite(session.actor, target);

    if (!allowed.ok) {
        ClanInviteService.notifyRejection(session, allowed.code, target);
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    // The invite belongs to the invited character: after Restart the same
    // connection may answer for another one.
    targetSession.pendingClanInvite = {
        requestorSession: session,
        invitedActor: target,
        clanId: allowed.clan.id
    };

    if (ClanInviteService.isBotSession(targetSession)) {
        return ClanInviteService.accept(targetSession, { answer: 1, automated: true });
    }

    return targetSession.dataSendToMe(ServerResponse.askJoinPledge(session.actor.fetchId(), allowed.clan.name));
}

module.exports = requestJoinPledge;
module.exports.consume = consume;
