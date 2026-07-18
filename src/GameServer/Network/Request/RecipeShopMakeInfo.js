const ReceivePacket = invoke('Packet/Receive');
const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');

module.exports = (session, buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 9) return session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed());
    const packet = new ReceivePacket(buffer);
    packet.readD().readD();
    ManufactureShop.makeInfo(session, packet.data[0], packet.data[1]);
};
