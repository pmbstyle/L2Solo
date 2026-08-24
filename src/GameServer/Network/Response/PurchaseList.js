const SendPacket = invoke('Packet/Send');
const WireD = invoke('Packet/WireD');

function bodyPart(item) {
    return item.isWearable() ? 2 ** item.fetchSlot() : 0;
}

function purchaseList(items, adena) {
    const packet = new SendPacket(0x11);

    packet
        .writeD(WireD.bounded(adena))
        .writeD(0x00) // List Id?
        .writeH(utils.size(items));

    items.forEach((item) => {
        packet
            .writeH(item.fetchClass1())
            .writeD(item.fetchId())
            .writeD(item.fetchSelfId())
            .writeD(WireD.bounded(item.fetchAmount()))
            .writeH(item.fetchClass2())
            .writeH(0x00) // ?
            .writeD(bodyPart(item))
            .writeH(item.fetchEnchantLevel?.() || 0)  // Enchant
            .writeH(0x00)  // ?
            .writeH(0x00)  // ?
            .writeD(WireD.bounded(item.fetchPrice()));
    });

    return packet.fetchBuffer();
}

module.exports = purchaseList;
