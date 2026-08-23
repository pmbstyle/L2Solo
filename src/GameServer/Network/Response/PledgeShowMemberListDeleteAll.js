const SendPacket = invoke('Packet/Send');

module.exports = () => new SendPacket(0x82).fetchBuffer();
