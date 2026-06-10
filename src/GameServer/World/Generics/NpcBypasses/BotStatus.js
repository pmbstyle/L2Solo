const BotManager = invoke('GameServer/Bot/BotManager');

function botStatus(session, parts) {
    const name = parts[1];
    let targetSession = null;

    if (name) {
        targetSession = BotManager.findSessionByName(name);
    } else if (session.actor && session.actor.fetchDestId()) {
        targetSession = BotManager.findSessionById(session.actor.fetchDestId());
    }

    BotManager.renderBotStatusPanel(session, targetSession);
}

module.exports = botStatus;
