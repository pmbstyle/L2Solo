const ReceivePacket = invoke('Packet/Receive');
const Enchant = invoke('GameServer/Enchant');

module.exports = function enchantItem(session, buffer) {
    if (!buffer || buffer.length < 5) return;
    const packet = new ReceivePacket(buffer).readD();
    Enchant.enchant(session, packet.data[0]).catch?.(() => {});
};
