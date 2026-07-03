const SendPacket = invoke('Packet/Send');

function dice(actor, selfId, number) {
    const packet = new SendPacket(0xd4);

    packet
        .writeD(actor.fetchId())
        .writeD(selfId)
        .writeD(number)
        .writeD(actor.fetchLocX() - 30)
        .writeD(actor.fetchLocY() - 30)
        .writeD(actor.fetchLocZ());

    return packet.fetchBuffer();
}

module.exports = dice;
