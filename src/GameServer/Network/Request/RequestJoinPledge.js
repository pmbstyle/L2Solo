const ReceivePacket = invoke('Packet/Receive');
const World = invoke('GameServer/World/World');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanInviteService = invoke('GameServer/Clan/ClanInviteService');
const ServerResponse = invoke('GameServer/Network/Response');
const ActionMessage = invoke('GameServer/Clan/ClanActionMessage');

function targetSessionById(id) {
    return (World.user?.sessions || []).find((session) => Number(session.actor?.fetchId?.()) === Number(id));
}

function requestJoinPledge(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD(); // Target object id

    consume(session, {
        targetId: packet.data[0]
    });
}

function consume(session, data) {
    const targetSession = targetSessionById(data.targetId);
    const target = targetSession?.actor;
    const allowed = ClanService.canInvite(session.actor, target);

    if (!allowed.ok) {
        session.dataSendToMe(ServerResponse.actionFailed());
        ActionMessage.failure(session, allowed.code);
        return;
    }

    targetSession.pendingClanInvite = {
        requestorSession: session,
        clanId: allowed.clan.id
    };

    ActionMessage.send(session, `Clan invitation sent to ${target.fetchName()}.`);

    if (ClanInviteService.isBotSession(targetSession)) {
        return ClanInviteService.accept(targetSession, { answer: 1, automated: true });
    }

    ActionMessage.send(targetSession, `${session.actor.fetchName()} invited you to join clan ${allowed.clan.name}.`);
    return targetSession.dataSendToMe(ServerResponse.askJoinPledge(session.actor.fetchId(), allowed.clan.name));
}

module.exports = requestJoinPledge;
module.exports.consume = consume;
