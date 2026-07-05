const SendPacket = invoke('Packet/Send');
const Helpers = invoke('GameServer/Network/Response/PledgeHelpers');

function pledgeShowMemberListAdd(member) {
    const packet = new SendPacket(0x55);

    packet
        .writeS(member.name)
        .writeD(member.level)
        .writeD(member.classId)
        .writeD(0)
        .writeD(1)
        .writeD(Helpers.memberOnlineObjectId(member));

    return packet.fetchBuffer();
}

module.exports = pledgeShowMemberListAdd;
