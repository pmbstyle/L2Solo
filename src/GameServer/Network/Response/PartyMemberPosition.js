const SendPacket = invoke('Packet/Send');

// C4 opcode 0xa7. The client uses this snapshot for party member markers on
// the minimap; it is deliberately a complete party snapshot, not a delta.
function partyMemberPosition(members = []) {
    const partyMembers = members.filter((member) => member?.fetchId && member?.fetchLocX && member?.fetchLocY && member?.fetchLocZ);
    const packet = new SendPacket(0xa7);
    packet.writeD(partyMembers.length);

    partyMembers.forEach((member) => {
        packet
            .writeD(member.fetchId())
            .writeD(Math.round(member.fetchLocX()))
            .writeD(Math.round(member.fetchLocY()))
            .writeD(Math.round(member.fetchLocZ()));
    });

    return packet.fetchBuffer();
}

module.exports = partyMemberPosition;
