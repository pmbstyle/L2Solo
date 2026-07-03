const SendPacket = invoke('Packet/Send');

function chooseInventoryItem(itemId) {
    return new SendPacket(0x6f)
        .writeD(itemId)
        .fetchBuffer();
}

module.exports = chooseInventoryItem;
