const SendPacket = invoke('Packet/Send');

function npcInfo(npc) {
    const packet = new SendPacket(0x16);

    packet
        .writeD(npc.fetchId())
        .writeD(npc.fetchDispSelfId())
        .writeD(npc.fetchAttackable())
        .writeD(npc.fetchLocX())
        .writeD(npc.fetchLocY())
        .writeD(npc.fetchLocZ())
        .writeD(npc.fetchHead())
        .writeD(0x00)  // ?
        .writeD(npc.fetchCollectiveCastSpd())
        .writeD(npc.fetchCollectiveAtkSpd())
        .writeD(npc.fetchCollectiveRunSpd())
        .writeD(npc.fetchCollectiveWalkSpd())
        .writeD(npc.fetchCollectiveRunSpd())  // Swim run speed
        .writeD(npc.fetchCollectiveWalkSpd()) // Swim walk speed
        .writeD(npc.fetchCollectiveRunSpd())  // Floating run speed
        .writeD(npc.fetchCollectiveWalkSpd()) // Floating walk speed
        .writeD(npc.fetchCollectiveRunSpd())  // Flying run speed
        .writeD(npc.fetchCollectiveWalkSpd()) // Flying walk speed
        .writeF(1.1)   // Move multiplier
        .writeF(npc.fetchAtkSpdMultiplier())
        .writeF(npc.fetchRadius())
        .writeF(npc.fetchSize())
        .writeD(npc.fetchWeapon())
        .writeD(npc.fetchArmor())
        .writeD(npc.fetchShield())
        .writeC(0x01)  // Name above character
        .writeC(npc.fetchStateRun())
        .writeC(npc.fetchStateAttack())
        .writeC(npc.fetchStateDead())
        .writeC(npc.fetchStateInvisible())
        .writeS(npc.fetchName())
        .writeS(npc.fetchTitle())
        .writeD(0x00)  // ?
        .writeD(0x00)  // Pvp?
        .writeD(0x00)  // Pk?
        .writeD(0x00)  // Abnormal effect
        .writeD(0x00)  // Clan Id
        .writeD(0x00)  // Clan crest
        .writeD(0x00)  // Ally Id
        .writeD(0x00)  // Ally crest
        .writeC(0x00)  // ?
        .writeC(0x00)  // Team circle color
        .writeF(npc.fetchRadius())
        .writeF(npc.fetchSize())
        .writeD(0x00); // C4 collision/team tail

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `npc=${npc.fetchId()}:${npc.fetchDispSelfId()}:${npc.fetchName()}`;
    return buffer;
}

module.exports = npcInfo;
