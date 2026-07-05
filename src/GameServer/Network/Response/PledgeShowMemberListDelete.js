const SendPacket = invoke('Packet/Send');

function pledgeShowMemberListDelete(name) {
    const packet = new SendPacket(0x56);

    packet
        .writeS(name);

    return packet.fetchBuffer();
}

module.exports = pledgeShowMemberListDelete;
