const SendPacket = invoke('Packet/Send');

module.exports = function doorPackets(door) {
    // C4 binds a server object to the door already present in the client map.
    return [
        new SendPacket(0x4c).writeD(door.objectId).writeD(door.id).fetchBuffer(),
        new SendPacket(0x4d).writeD(door.objectId).writeD(door.open ? 0 : 1)
            .writeD(0).writeD(0).writeD(door.id).writeD(door.maxHp).writeD(door.maxHp).fetchBuffer()
    ];
};
