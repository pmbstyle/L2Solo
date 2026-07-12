const SendPacket = invoke('Packet/Send');

// C4 ExAutoSoulShot: FE:12 dd
function autoSoulShot(selfId, enabled) {
    return new SendPacket(0xfe)
        .writeH(0x12)
        .writeD(selfId)
        .writeD(enabled ? 1 : 0)
        .fetchBuffer();
}

module.exports = autoSoulShot;
