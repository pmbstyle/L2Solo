const ReceivePacket = invoke('Packet/Receive');
const PrivateStore = invoke('GameServer/PrivateStore');
module.exports = (session, buffer) => {
    if (!buffer || buffer.length < 5) return;
    const packet = new ReceivePacket(buffer); packet.readD(); const count = Number(packet.data[0]);
    if (!Number.isSafeInteger(count) || count < 1 || count > 4 || buffer.length !== 5 + count * 16) return;
    const rows = []; for (let i = 0; i < count; i += 1) { packet.readD().readH().readH().readD().readD(); rows.push({ selfId: packet.data[1 + i * 5], enchant: packet.data[2 + i * 5], count: packet.data[4 + i * 5], price: packet.data[5 + i * 5] }); }
    if (!PrivateStore.publishBuy(session, rows)) session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed());
};
