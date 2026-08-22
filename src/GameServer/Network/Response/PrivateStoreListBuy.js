const SendPacket = invoke('Packet/Send');
const DataCache = invoke('GameServer/DataCache');
const WireD = invoke('Packet/WireD');

function referencePrice(item) {
    const template = (DataCache.items || []).find((entry) => (
        Number(entry.selfId) === Number(item.fetchSelfId())
    ));
    const templatePrice = WireD.isRepresentable(template?.template?.price)
        ? Number(template.template.price)
        : null;
    if (templatePrice !== null) return templatePrice;
    return WireD.isRepresentable(item.fetchPrice?.()) ? Number(item.fetchPrice()) : null;
}

function bodyPart(item) {
    return item.isWearable() ? 2 ** item.fetchSlot() : 0;
}

// C4 PrivateStoreListBuy (0xb8). Unlike the generic NPC SellList, this
// packet identifies the seated buyer and makes the client send 0x96.
function privateStoreListBuy(merchant, rows, adena) {
    const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => {
        const item = row?.item;
        return item
            && WireD.isRepresentable(item.fetchId?.())
            && WireD.isRepresentable(item.fetchSelfId?.())
            && WireD.isRepresentable(row.amount)
            && referencePrice(item) !== null
            && WireD.isRepresentable(bodyPart(item))
            && WireD.isRepresentable(item.fetchClass2?.())
            && WireD.isRepresentable(row.price);
    });

    const packet = new SendPacket(0xb8);
    packet
        .writeD(WireD.bounded(merchant.fetchId()))
        // C4 has no wider adena field. Saturate the display value at the
        // 32-bit wire limit; trade authorization still uses the server-side
        // wallet.
        .writeD(WireD.bounded(adena))
        .writeD(safeRows.length);

    safeRows.forEach((row) => {
        const item = row.item;
        packet
            .writeD(item.fetchId())
            .writeD(item.fetchSelfId())
            .writeH(item.fetchEnchantLevel?.() || 0) // Enchant
            .writeD(row.amount)
            // The client expects the immutable datapack reference price here.
            // Do not trust a mutable/runtime item price: a corrupt value can
            // exceed the signed C4 D range and otherwise terminate the server.
            .writeD(referencePrice(item))
            .writeH(0)
            .writeD(bodyPart(item))
            .writeH(item.fetchClass2())
            .writeD(row.price)
            .writeD(row.amount);
    });

    return packet.fetchBuffer();
}

module.exports = privateStoreListBuy;
