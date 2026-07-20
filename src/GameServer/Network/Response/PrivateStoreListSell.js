const SendPacket = invoke('Packet/Send');

function bodyPart(item) { return item.isWearable() ? 2 ** item.fetchSlot() : 0; }

// C4 PrivateStoreListSell (0x9b), shown to a customer selecting a player
// seller. The client later submits RequestPrivateStoreBuy (0x79).
module.exports = function privateStoreListSell(seller, customer) {
    const store = seller.fetchPrivateStore?.() || { items: [] };
    const rows = (store.items || []).map((row) => ({ row, item: seller.backpack.fetchItemRaw(row.objectId) }))
        .filter(({ row, item }) => item && !item.fetchEquipped() && item.fetchAmount() >= row.count);
    const packet = new SendPacket(0x9b);
    packet.writeD(seller.fetchId()).writeD(store.packageSale ? 1 : 0).writeD(customer.backpack.fetchTotalAdena()).writeD(rows.length);
    rows.forEach(({ row, item }) => {
        packet.writeD(item.fetchClass2()).writeD(item.fetchId()).writeD(item.fetchSelfId()).writeD(row.count)
            .writeH(0).writeH(0).writeH(0).writeD(bodyPart(item)).writeD(row.price);
    });
    return packet.fetchBuffer();
};
