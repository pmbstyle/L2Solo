const SendPacket = invoke('Packet/Send');

function etcStatusUpdate(actor) {
    const packet = new SendPacket(0xf3);

    packet
        .writeD(Math.round(Number(actor.fetchCharges?.()) || 0))
        .writeD(Math.round(Number(actor.fetchWeightPenalty?.()) || 0))
        .writeD(actor.fetchMessageRefusal?.() || actor.fetchChatBanned?.() ? 1 : 0)
        .writeD(actor.fetchInsideDangerArea?.() ? 1 : 0)
        .writeD(Math.min(Math.round(Number(actor.fetchExpertisePenalty?.()) || 0), 1));

    return packet.fetchBuffer();
}

module.exports = etcStatusUpdate;
