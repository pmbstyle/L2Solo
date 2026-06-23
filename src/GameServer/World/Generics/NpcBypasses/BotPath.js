const BotManager = invoke('GameServer/Bot/BotManager');

function botPath(session, parts) {
    const name = parts[1];
    let targetSession = null;

    if (name) {
        targetSession = BotManager.findSessionByName(name);
    } else if (session.actor && session.actor.fetchDestId()) {
        targetSession = BotManager.findSessionById(session.actor.fetchDestId());
    }

    BotManager.renderBotPathPanel(session, targetSession);
}

module.exports = botPath;
