const SendPacket = invoke('Packet/Send');

function privateStoreBuyMsg(actor, storeTitle) {
    // C4 PrivateStoreMsgBuy mirrors the sell packet, with its own opcode.
    const packet = new SendPacket(0xb9);
    packet.writeD(actor.fetchId());
    packet.writeS(typeof storeTitle === 'string' ? storeTitle : actor.fetchTitle());
    return packet.fetchBuffer();
}

module.exports = privateStoreBuyMsg;
