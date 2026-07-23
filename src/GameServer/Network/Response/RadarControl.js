const SendPacket = invoke('Packet/Send');

// C4 RadarControl (0xEB): the client expects the radar to be armed before
// receiving the visible waypoint marker.
function radarControl(showRadar, type, locX, locY, locZ) {
    const packet = new SendPacket(0xeb);

    packet
        .writeD(showRadar)
        .writeD(type)
        .writeD(locX)
        .writeD(locY)
        .writeD(locZ);

    return packet.fetchBuffer();
}

module.exports = radarControl;
