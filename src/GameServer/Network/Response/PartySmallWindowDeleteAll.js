const SendPacket = invoke('Packet/Send');

function partySmallWindowDeleteAll() {
    return new SendPacket(0x51).fetchBuffer();
}

module.exports = partySmallWindowDeleteAll;
