const ReceivePacket = invoke('Packet/Receive');
const PrivateStore = invoke('GameServer/PrivateStore');
module.exports = (type) => (session, buffer) => { const packet = new ReceivePacket(buffer); packet.readS(); if (!PrivateStore.setTitle(session, type, packet.data[0])) session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed()); };
