const SendPacket = invoke('Packet/Send');

function petStatusUpdate(summon) {
    const packet = new SendPacket(0xb5);
    const remaining = Number(summon.summonTimeRemaining);
    const total = Number(summon.summonTotalLifeTime);

    packet
        .writeD(1)
        .writeD(summon.fetchId())
        .writeD(summon.fetchLocX())
        .writeD(summon.fetchLocY())
        .writeD(summon.fetchLocZ())
        .writeS('')
        .writeD(Number.isFinite(remaining) ? remaining : Number(summon.fetchCurrentFeed?.()) || 0)
        .writeD(Number.isFinite(total) ? total : Number(summon.fetchMaxFeed?.()) || 0)
        .writeD(summon.fetchHp())
        .writeD(summon.fetchMaxHp())
        .writeD(summon.fetchMp())
        .writeD(summon.fetchMaxMp())
        .writeD(summon.fetchLevel())
        .writeD(0)
        .writeD(0)
        .writeD(0);

    return packet.fetchBuffer();
}

module.exports = petStatusUpdate;
