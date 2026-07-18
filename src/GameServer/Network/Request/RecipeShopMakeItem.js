const ReceivePacket = invoke('Packet/Receive');
const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');

module.exports = (session, buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 13) return Promise.resolve(session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed()));
    const packet = new ReceivePacket(buffer);
    packet.readD().readD().readD();
    return ManufactureShop.craft(session, packet.data[0], packet.data[1]);
};
