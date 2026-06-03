const SendPacket = invoke('Packet/Send');

function partySmallWindowAll(partyLeaderId, distribution, members) {
    const packet = new SendPacket(0x4e);

    packet
        .writeD(partyLeaderId)
        .writeD(distribution)
        .writeD(members.length);

    members.forEach((member) => {
        packet
            .writeD(member.fetchId())
            .writeS(member.fetchName())
            .writeD(0) // curCP
            .writeD(0) // maxCP
            .writeD(member.fetchHp())
            .writeD(member.fetchMaxHp())
            .writeD(member.fetchMp())
            .writeD(member.fetchMaxMp())
            .writeD(member.fetchLevel())
            .writeD(member.fetchClassId())
            .writeD(0)
            .writeD(member.fetchRace());
    });

    return packet.fetchBuffer();
}

module.exports = partySmallWindowAll;
