const SendPacket = invoke('Packet/Send');

function partySmallWindowAll(partyLeaderId, distribution, members) {
    const packet = new SendPacket(0x4e); // Opcode 0x4e

    packet
        .writeD(partyLeaderId)
        .writeD(distribution)
        .writeD(members.length);

    members.forEach((member) => {
        const id = member.fetchId();
        const name = member.fetchName();
        const cp = Math.round(member.fetchCp());
        const maxCp = Math.round(member.fetchMaxCp());
        const hp = Math.round(member.fetchHp());
        const maxHp = Math.round(member.fetchMaxHp());
        const mp = Math.round(member.fetchMp());
        const maxMp = Math.round(member.fetchMaxMp());
        const lvl = member.fetchLevel();
        const classId = member.fetchClassId();

        packet
            .writeD(id)        // 1: id
            .writeS(name)      // 2: name
            .writeD(cp)        // 3: cp
            .writeD(maxCp)     // 4: maxCp
            .writeD(hp)        // 5: hp
            .writeD(maxHp)     // 6: maxHp
            .writeD(mp)        // 7: mp
            .writeD(maxMp)     // 8: maxMp
            .writeD(lvl)       // 9: lvl
            .writeD(classId)   // 10: classId
            .writeD(0)         // 11: has pet (0 = no)
            .writeD(0);        // 12: pet template/object ID
    });

    return packet.fetchBuffer();
}

module.exports = partySmallWindowAll;
