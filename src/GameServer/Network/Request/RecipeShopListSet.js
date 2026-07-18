const ReceivePacket = invoke('Packet/Receive');
const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');
module.exports = (session, buffer) => {
    if (!buffer || buffer.length < 5) return;
    const packet = new ReceivePacket(buffer); packet.readD(); const count = Number(packet.data[0]);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100 || buffer.length !== 5 + (count * 8)) return;
    const entries = []; for (let i = 0; i < count; i += 1) { packet.readD().readD(); entries.push({ recipeId: packet.data[1 + (i * 2)], price: packet.data[2 + (i * 2)] }); }
    if (!ManufactureShop.publish(session, entries)) session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed());
};
