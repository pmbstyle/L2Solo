const SendPacket = invoke('Packet/Send');

function privateStoreBuyMsg(actor, storeTitle) {
    const packet = new SendPacket(0x8c);
    packet.writeD(actor.fetchId());
    packet.writeD(3); // Private store type: Buy (3)
    packet.writeS(typeof storeTitle === 'string' ? storeTitle : actor.fetchTitle());
    return packet.fetchBuffer();
}

module.exports = privateStoreBuyMsg;
