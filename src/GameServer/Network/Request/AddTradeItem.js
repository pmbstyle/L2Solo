const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');

function addTradeItem(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD() // trade id, ignored for bot trade
        .readD() // object id
        .readD(); // count

    const result = BotTradeService.addItem(session, packet.data[1], packet.data[2]);
    if (!result.ok) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    session.dataSendToMe(ServerResponse.tradeOwnAdd(result.line));
}

module.exports = addTradeItem;
