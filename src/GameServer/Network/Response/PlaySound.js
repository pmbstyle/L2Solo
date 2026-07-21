const SendPacket = invoke('Packet/Send');

// C4 PlaySound: type 0 is an immediate client sound, not positional music.
function playSound(sound) {
    const packet = new SendPacket(0x98);

    packet
        .writeD(0)
        .writeS(sound)
        .writeD(0)
        .writeD(0)
        .writeD(0)
        .writeD(0)
        .writeD(0);

    return packet.fetchBuffer();
}

module.exports = playSound;
