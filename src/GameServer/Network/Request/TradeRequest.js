const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');

function tradeRequest(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet.readD(); // target object id

    const targetSession = BotManager.findSessionById(packet.data[0]);
    const result = BotTradeService.startPlayerTrade(session, targetSession);

    if (!result.ok) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    session.dataSendToMe(ServerResponse.tradeStart(
        targetSession.actor,
        session.actor.backpack.fetchItems()
    ));
}

module.exports = tradeRequest;
