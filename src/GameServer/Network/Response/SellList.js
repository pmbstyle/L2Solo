const SendPacket = invoke('Packet/Send');
const WireD = invoke('Packet/WireD');

function bodyPart(item) {
    return item.isWearable() ? 2 ** item.fetchSlot() : 0;
}

function sellList(rows, adena) {
    const packet = new SendPacket(0x10);

    packet
        .writeD(WireD.bounded(adena))
        .writeD(0x00)
        .writeH(utils.size(rows));

    rows.forEach((row) => {
        const item = row.item;

        packet
            .writeH(item.fetchClass1())
            .writeD(item.fetchId())
            .writeD(item.fetchSelfId())
            .writeD(WireD.bounded(row.amount))
            .writeH(item.fetchClass2())
            .writeH(0x00)
            .writeD(bodyPart(item))
            .writeH(0x00)
            .writeH(0x00)
            .writeH(0x00)
            .writeD(WireD.bounded(row.price));
    });

    return packet.fetchBuffer();
}

module.exports = sellList;
