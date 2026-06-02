const ServerResponse = invoke('GameServer/Network/Response');

module.exports = {
    tick(session, bot, Generics, BotAI) {
        if (session.townGossip) {
            // 3% chance per tick to attempt conversation when resting near other bots
            if (Math.random() < 0.03) {
                try {
                    const BotManager = invoke('GameServer/Bot/BotManager');
                    BotManager.checkAndStartConversation(session);
                } catch (err) {
                    console.error("Conversation check error:", err);
                }
            }
            return; // Stay seated and do nothing else
        }

        const hpRatio = bot.fetchHp() / bot.fetchMaxHp();
        const mpRatio = bot.fetchMp() / bot.fetchMaxMp();
        if (hpRatio >= 0.95 && mpRatio >= 0.95) {
            bot.state.setSeated(false);
            session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
            session.plan = 'hunting';
            BotAI.say(session, "Fully rested! Ready to hunt again.");
        } else {
            // 3% chance per tick to attempt conversation when resting near other bots
            if (Math.random() < 0.03) {
                try {
                    const BotManager = invoke('GameServer/Bot/BotManager');
                    BotManager.checkAndStartConversation(session);
                } catch (err) {
                    console.error("Conversation check error:", err);
                }
            }
        }
    }
};
