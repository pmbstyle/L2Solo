const SendPacket = invoke('Packet/Send');
const writeTradeItem = require('./TradeItemLine');

function tradeOtherAdd(line) {
    const packet = new SendPacket(0x21);

    packet.writeH(1);
    writeTradeItem(packet, line.item, line.count);

    return packet.fetchBuffer();
}

module.exports = tradeOtherAdd;
