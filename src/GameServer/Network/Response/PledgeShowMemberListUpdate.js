const SendPacket = invoke('Packet/Send');
const Helpers = invoke('GameServer/Network/Response/PledgeHelpers');

function value(actorOrMember, fetcher, key, fallback = 0) {
    if (actorOrMember?.[fetcher]) return actorOrMember[fetcher]();
    return actorOrMember?.[key] ?? fallback;
}

function pledgeShowMemberListUpdate(actorOrMember) {
    const member = actorOrMember || {};
    const packet = new SendPacket(0x54);

    packet
        .writeS(value(member, 'fetchName', 'name', ''))
        .writeD(value(member, 'fetchLevel', 'level', 0))
        .writeD(value(member, 'fetchClassId', 'classId', 0))
        .writeD(0)
        .writeD(1)
        .writeD(Helpers.memberOnlineObjectId({
            id: value(member, 'fetchId', 'id', 0)
        }));

    return packet.fetchBuffer();
}

module.exports = pledgeShowMemberListUpdate;
