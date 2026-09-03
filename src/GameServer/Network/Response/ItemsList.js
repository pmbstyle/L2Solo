const SendPacket = invoke('Packet/Send');
const WireD = invoke('Packet/WireD');
const ItemSlot = invoke('GameServer/Item/ItemSlot');

function itemsList(items, popup = false) {
    const packet = new SendPacket(0x1b);
    const safeItems = (Array.isArray(items) ? items : []).filter((item) => (
        item
        && WireD.isRepresentable(item.fetchId?.())
        && WireD.isRepresentable(item.fetchSelfId?.())
    ));

    packet
        .writeH(popup)
        .writeH(utils.size(safeItems));

    safeItems.forEach((item) => {
        packet
            .writeH(item.fetchClass1())
            .writeD(item.fetchId())
            .writeD(item.fetchSelfId())
            // Inventory counts are unsigned C4 D fields. Keep the server-side
            // amount intact, but saturate an oversized display value so one
            // corrupt/legacy stack cannot terminate the game process.
            .writeD(WireD.bounded(item.fetchAmount()))
            .writeH(item.fetchClass2())
            .writeH(0x00)  // ?
            .writeH(item.fetchEquipped())
            .writeD(WireD.bounded(ItemSlot.bodyPart(item)))
            .writeH(item.fetchEnchantLevel?.() || 0)  // Enchant level
            .writeH(0x00); // ?
    });

    return packet.fetchBuffer();
}

module.exports = itemsList;
