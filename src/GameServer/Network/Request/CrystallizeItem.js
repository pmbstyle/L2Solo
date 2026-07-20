const ReceivePacket = invoke('Packet/Receive');
const Crystallize = invoke('GameServer/Crystallize');
module.exports = (session, buffer) => { if (!buffer || buffer.length < 9) return; const packet = new ReceivePacket(buffer); packet.readD().readD(); Crystallize.crystallize(session, packet.data[0], packet.data[1]); };
