const SendPacket = invoke('Packet/Send');

function pledgeShowInfoUpdate(clan) {
    const packet = new SendPacket(0x88);

    packet
        .writeD(clan.id)
        .writeD(clan.crestId || 0)
        .writeD(clan.level || 0)
        .writeD(0) // Castle
        .writeD(0) // Hideout / Clan Hall
        .writeD(0)
        .writeD(clan.members.find((member) => Number(member.id) === Number(clan.leaderId))?.level || 0)
        .writeD(clan.dissolvingExpiryTime > Date.now() ? 3 : 0)
        .writeD(0)
        .writeD(clan.allyId || 0)
        .writeS(clan.allyName || '')
        .writeD(clan.allyCrestId || 0)
        .writeD(0); // Clan war state

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `clan=${clan.id}:level=${clan.level}:members=${clan.members.length}`;
    return buffer;
}

module.exports = pledgeShowInfoUpdate;
