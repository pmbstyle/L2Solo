const TradeChat = invoke('GameServer/Bot/Economy/BotTradeChat');

module.exports = {
    tick(session) {
        TradeChat.offer(session);
    }
};
