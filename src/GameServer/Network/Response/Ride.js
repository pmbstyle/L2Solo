const SendPacket = invoke('Packet/Send');

module.exports = function ride(actor, mounted) {
    return new SendPacket(0x86)
        .writeD(actor.fetchId())
        .writeD(mounted ? 1 : 0)
        .writeD(mounted ? 1 : 0)
        .writeD(1000000 + (mounted ? actor.pet.fetchSelfId() : 0))
        .fetchBuffer();
};
