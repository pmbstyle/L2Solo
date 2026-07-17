const SendPacket = invoke('Packet/Send');

function bodyPart(item) {
    return item.isWearable?.() ? 2 ** item.fetchSlot() : 0;
}

// C4 0x41: native personal-warehouse deposit window.
module.exports = function wareHouseDepositList(items, adena) {
    const packet = new SendPacket(0x41);
    packet.writeH(1).writeD(adena).writeH(items.length);
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
