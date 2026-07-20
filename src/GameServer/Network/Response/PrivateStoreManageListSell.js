const SendPacket = invoke('Packet/Send');

function bodyPart(item) {
    return item.isWearable() ? 2 ** item.fetchSlot() : 0;
}

// C4 PrivateStoreManageListSell (0x9a): inventory candidates followed by
// the current private-sell list.
module.exports = function privateStoreManageListSell(actor, store) {
    const packet = new SendPacket(0x9a);
    const listed = new Map((store?.items || []).map((row) => [Number(row.objectId), row]));
    const available = actor.backpack.fetchItems().filter((item) => !item.fetchEquipped() && item.fetchSelfId() !== 57);

    packet.writeD(actor.fetchId()).writeD(store?.packageSale ? 1 : 0).writeD(actor.backpack.fetchTotalAdena());
    packet.writeD(available.length);
    available.forEach((item) => {
        packet.writeD(item.fetchClass2()).writeD(item.fetchId()).writeD(item.fetchSelfId())
            .writeD(item.fetchAmount()).writeH(0).writeH(0).writeH(0)
            .writeD(bodyPart(item)).writeD(listed.get(Number(item.fetchId()))?.price || item.fetchPrice());
    });

    const current = (store?.items || []).map((row) => ({ row, item: actor.backpack.fetchItemRaw(row.objectId) })).filter((entry) => entry.item);
    packet.writeD(current.length);
    current.forEach(({ row, item }) => {
        packet.writeD(item.fetchClass2()).writeD(item.fetchId()).writeD(item.fetchSelfId())
            .writeD(row.count).writeH(0).writeH(0).writeH(0)
            .writeD(bodyPart(item)).writeD(row.price).writeD(item.fetchPrice());
    });
    return packet.fetchBuffer();
};
