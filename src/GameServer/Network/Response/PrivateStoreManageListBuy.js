const SendPacket = invoke('Packet/Send');
const DataCache = invoke('GameServer/DataCache');

function bodyPart(item) { return item.isWearable() ? 2 ** item.fetchSlot() : 0; }

// C4 PrivateStoreManageListBuy (0xb7): selectable inventory templates and
// the demand already configured by the player.
module.exports = function privateStoreManageListBuy(actor, store) {
    const packet = new SendPacket(0xb7);
    const candidates = actor.backpack.fetchItems().filter((item) => item.fetchSelfId() !== 57);
    packet.writeD(actor.fetchId()).writeD(actor.backpack.fetchTotalAdena()).writeD(candidates.length);
    candidates.forEach((item) => {
        packet.writeD(item.fetchSelfId()).writeH(0).writeD(item.fetchAmount()).writeD(item.fetchPrice())
            .writeH(0).writeD(bodyPart(item)).writeH(item.fetchClass2());
    });
    const rows = (store?.items || []).map((row) => ({ row, template: DataCache.items.find((entry) => Number(entry.selfId) === Number(row.selfId)) })).filter((entry) => entry.template);
    packet.writeD(rows.length);
    rows.forEach(({ row, template }) => {
        const item = { isWearable: () => !!template.etc?.slot, fetchSlot: () => template.etc?.slot || 0 };
        packet.writeD(row.selfId).writeH(row.enchant || 0).writeD(row.count).writeD(template.template?.price || 0)
            .writeH(0).writeD(bodyPart(item)).writeH(template.template?.class2 || 0)
            .writeD(row.price).writeD(template.template?.price || 0);
    });
    return packet.fetchBuffer();
};
