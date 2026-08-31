const SendPacket = invoke('Packet/Send');

function bodyPart(item) {
    return item.isWearable?.() ? 2 ** item.fetchSlot() : 0;
}

// C4 0x42: warehouse type 1 is private, type 2 is clan.
module.exports = function wareHouseWithdrawalList(items, adena, type = 1) {
    const packet = new SendPacket(0x42);
    packet.writeH(type).writeD(adena).writeH(items.length);
    items.forEach((item) => {
        packet
            .writeH(item.fetchClass1())
            .writeD(item.fetchId())
            .writeD(item.fetchSelfId())
            .writeD(item.fetchAmount())
            .writeH(item.fetchClass2())
            .writeH(0)
            .writeD(bodyPart(item))
            .writeH(0).writeH(0).writeH(0)
            .writeD(item.fetchId());
    });
    return packet.fetchBuffer();
};
