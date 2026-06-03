const SendPacket = invoke('Packet/Send');

function partySmallWindowAll(partyLeaderId, distribution, members) {
    const packet = new SendPacket(0x4e);

    packet
        .writeD(members.length) // Количество участников ПЕРВЫМ полем
        .writeD(partyLeaderId)
        .writeD(distribution);

    members.forEach((member) => {
        const id = member.fetchId();
        const name = member.fetchName();
        const hp = Math.round(member.fetchHp());
        const maxHp = Math.round(member.fetchMaxHp());
        const mp = Math.round(member.fetchMp());
        const maxMp = Math.round(member.fetchMaxMp());
        const lvl = member.fetchLevel();
        const classId = member.fetchClassId();

        packet
            .writeD(id)
            .writeS(name)
            .writeD(hp)
            .writeD(maxHp)
            .writeD(mp)
            .writeD(maxMp)
            .writeD(lvl)
            .writeD(classId)
            .writeD(member.fetchRace()); // 9-е поле (race)
    });

    return packet.fetchBuffer();
}

module.exports = partySmallWindowAll;
