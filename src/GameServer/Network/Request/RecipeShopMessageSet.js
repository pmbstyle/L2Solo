const ReceivePacket = invoke('Packet/Receive');
const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');
module.exports = (session, buffer) => { const packet = new ReceivePacket(buffer); packet.readS(); if (!ManufactureShop.title(session, packet.data[0])) session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed()); };
