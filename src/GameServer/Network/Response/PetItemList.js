const SendPacket = invoke('Packet/Send');
const ItemSlot = invoke('GameServer/Item/ItemSlot');
module.exports = items => {
    const packet = new SendPacket(0xb2).writeH(items.length);
    for (const item of items) packet.writeH(item.fetchClass1()).writeD(item.fetchId()).writeD(item.fetchSelfId())
        .writeD(item.fetchAmount()).writeH(item.fetchClass2()).writeH(0xff).writeH(item.fetchEquipped() ? 1 : 0)
        .writeD(ItemSlot.bodyPart(item)).writeH(item.fetchEnchantLevel()).writeH(0);
    return packet.fetchBuffer();
};
