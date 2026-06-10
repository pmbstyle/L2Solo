const SendPacket = invoke('Packet/Send');

function privateStoreMsg(actor, storeTitle) {
    const packet = new SendPacket(0x8c);
    packet.writeD(actor.fetchId());
    packet.writeD(1); // Private store type: Sell (1)
    packet.writeS(typeof storeTitle === 'string' ? storeTitle : actor.fetchTitle());
    return packet.fetchBuffer();
}

module.exports = privateStoreMsg;
