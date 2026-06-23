const SendPacket = invoke('Packet/Send');

function partySmallWindowDeleteAll() {
    return new SendPacket(0x50).fetchBuffer();
}

module.exports = partySmallWindowDeleteAll;
