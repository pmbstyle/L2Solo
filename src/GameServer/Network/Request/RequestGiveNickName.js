const ReceivePacket = invoke('Packet/Receive');
const World = invoke('GameServer/World/World');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function onlineSessionByName(name) {
    const lookup = String(name || '').toLowerCase();
    return (World.user?.sessions || []).find((session) => (
        String(session.actor?.fetchName?.() || '').toLowerCase() === lookup
    ));
}

function requestGiveNickName(session, buffer) {
    const packet = new ReceivePacket(buffer);
    packet.readS().readS();
    return consume(session, { name: packet.data[0], title: packet.data[1] });
}

function consume(session, data) {
    const clan = ClanService.clanForActor(session.actor);
    const member = clan?.members?.find((entry) => (
        String(entry.name || '').toLowerCase() === String(data.name || '').toLowerCase()
    ));
    const targetSession = member ? onlineSessionByName(member.name) : null;

    if (!member || !targetSession?.actor) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: member ? 'target_offline' : 'not_member' });
    }

    return ClanService.setMemberTitle(session.actor, targetSession.actor, data.title).then((result) => {
        if (!result.ok) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return result;
        }

        targetSession.dataSendToMe(ServerResponse.userInfo(targetSession.actor));
        targetSession.dataSendToOthers?.(ServerResponse.charInfo(targetSession.actor), targetSession.actor);
        targetSession.dataSendToOthers?.(ServerResponse.relationChanged(targetSession.actor), targetSession.actor);
        return result;
    }).catch((err) => {
        utils.infoWarn('Clan', 'set clan member title failed: %s', err.message);
        session.dataSendToMe(ServerResponse.actionFailed());
        return { ok: false, code: 'title_failed' };
    });
}

requestGiveNickName.consume = consume;
module.exports = requestGiveNickName;
