const ReceivePacket = invoke('Packet/Receive');
const World = invoke('GameServer/World/World');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function onlineSessionByActorId(id) {
    return (World.user?.sessions || []).find((session) => Number(session.actor?.fetchId?.()) === Number(id));
}

function requestOustPledgeMember(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readS(); // Target name

    return consume(session, {
        name: packet.data[0]
    });
}

function consume(session, data) {
    const actor = session.actor;
    const clan = ClanService.clanForActor(actor);
    if (!clan || !ClanService.isLeader(actor, clan)) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: 'not_authorized' });
    }

    const member = clan.members.find((entry) => entry.name.toLowerCase() === String(data.name || '').toLowerCase());
    const targetSession = member ? onlineSessionByActorId(member.id) : null;
    if (!member || Number(member.id) === Number(actor.fetchId())) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: member ? 'leader_cannot_leave' : 'not_member' });
    }

    return ClanService.removeMemberById(clan, member.id, { force: true, actor: targetSession?.actor }).then((result) => {
        if (!result.ok) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return result;
        }
        if (targetSession?.actor) {
            targetSession.dataSendToMe(ServerResponse.userInfo(targetSession.actor));
            targetSession.dataSendToMe(ServerResponse.pledgeShowMemberListDelete(member.name));
            targetSession.dataSendToOthers?.(ServerResponse.charInfo(targetSession.actor), targetSession.actor);
            targetSession.dataSendToOthers?.(ServerResponse.relationChanged(targetSession.actor), targetSession.actor);
        }
        ClanService.onlineSessions(result.clan).forEach((memberSession) => {
            memberSession.dataSendToMe(ServerResponse.pledgeShowMemberListDelete(member.name));
            memberSession.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(result.clan));
        });
        return result;
    }).catch((err) => {
        utils.infoWarn('Clan', 'oust clan member failed: %s', err.message);
        session.dataSendToMe(ServerResponse.actionFailed());
        return { ok: false, code: 'oust_failed' };
    });
}

requestOustPledgeMember.consume = consume;
module.exports = requestOustPledgeMember;
