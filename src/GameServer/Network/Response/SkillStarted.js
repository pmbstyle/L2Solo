const SendPacket = invoke('Packet/Send');

function skillStarted(actor, npcId, skill) {
    const packet = new SendPacket(0x48);

    packet
        .writeD(actor.fetchId())
        .writeD(npcId)
        .writeD(skill.fetchSelfId())
        .writeD(skill.fetchLevel?.() ?? 1)
        .writeD(skill.fetchCalculatedHitTime())
        .writeD(skill.fetchReuseTime())
        .writeD(actor.fetchLocX())
        .writeD(actor.fetchLocY())
        .writeD(actor.fetchLocZ())
        .writeD(0x00);

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `actor=${actor.fetchId()}:target=${npcId}:skill=${skill.fetchSelfId()}:level=${skill.fetchLevel?.() ?? 1}:hitTime=${skill.fetchCalculatedHitTime()}`;
    return buffer;
}

module.exports = skillStarted;
