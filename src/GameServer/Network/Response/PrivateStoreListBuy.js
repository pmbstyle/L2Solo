const SendPacket = invoke('Packet/Send');

function bodyPart(item) {
    return item.isWearable() ? 2 ** item.fetchSlot() : 0;
}

// C4 PrivateStoreListBuy (0xb8). Unlike the generic NPC SellList, this
// packet identifies the seated buyer and makes the client send 0x96.
function privateStoreListBuy(merchant, rows, adena) {
    const packet = new SendPacket(0xb8);
    packet
        .writeD(merchant.fetchId())
        .writeD(adena)
        .writeD(utils.size(rows));

    rows.forEach((row) => {
        const item = row.item;
        packet
            .writeD(item.fetchId())
            .writeD(item.fetchSelfId())
            .writeH(0) // Enchant
            .writeD(row.amount)
            .writeD(item.fetchPrice())
            .writeH(0)
            .writeD(bodyPart(item))
            .writeH(item.fetchClass2())
            .writeD(row.price)
            .writeD(row.amount);
    });

    return packet.fetchBuffer();
}

module.exports = privateStoreListBuy;
