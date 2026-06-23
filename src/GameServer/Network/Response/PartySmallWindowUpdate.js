const SendPacket = invoke('Packet/Send');

function partySmallWindowUpdate(member) {
    const packet = new SendPacket(0x52); // Opcode 0x52

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
        .writeD(id)
        .writeS(name)
        .writeD(cp)
        .writeD(maxCp)
        .writeD(hp)
        .writeD(maxHp)
        .writeD(mp)
        .writeD(maxMp)
        .writeD(lvl)
        .writeD(classId);

    return packet.fetchBuffer();
}

module.exports = partySmallWindowUpdate;
