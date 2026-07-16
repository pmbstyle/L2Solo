const BotManager = invoke('GameServer/Bot/BotManager');

function botStatus(session, parts) {
    const name = parts[1];
    let targetSession = null;

    if (name) {
        targetSession = BotManager.findSessionByName(name);
        if (!targetSession) {
            const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
            return LifeState.findByName(name).then((coldState) => {
                if (coldState) BotManager.renderColdBotStatusPanel(session, coldState);
                else BotManager.renderBotStatusPanel(session, null);
            });
        }
    } else if (session.actor && session.actor.fetchDestId()) {
        targetSession = BotManager.findSessionById(session.actor.fetchDestId());
    }

    BotManager.renderBotStatusPanel(session, targetSession);
}

module.exports = botStatus;
