function writeTradeItem(packet, item, amount = item.fetchAmount()) {
    packet
        .writeH(item.fetchClass1())
        .writeD(item.fetchId())
        .writeD(item.fetchSelfId())
        .writeD(amount)
        .writeH(item.fetchClass2())
        .writeH(0x00)
        .writeD(item.isWearable() ? item.fetchSlot() : 0)
        .writeH(0x00)
        .writeH(0x00)
        .writeH(0x00);

    return packet;
}

module.exports = writeTradeItem;
