const SendPacket = invoke('Packet/Send');
const writeTradeItem = require('./TradeItemLine');

function tradeStart(partnerActor, items) {
    const packet = new SendPacket(0x1e);
    const tradableItems = items.filter((item) => item && !item.fetchEquipped());

    packet
        .writeD(partnerActor.fetchId())
        .writeH(utils.size(tradableItems));

    tradableItems.forEach((item) => {
        writeTradeItem(packet, item);
    });

    return packet.fetchBuffer();
}

module.exports = tradeStart;
