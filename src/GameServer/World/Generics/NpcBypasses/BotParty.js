const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotManager = invoke('GameServer/Bot/BotManager');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

function pct(value) {
    return `${Math.round((value || 0) * 100)}%`;
}

function dist(value) {
    if (value === null || value === undefined) return '?';
    return `${Math.round(value)}`;
}

function render(session) {
    const actor = session.actor;
    if (!actor) return;

    const candidates = BotAvailability.listForPlayer(
        session,
        BotManager.sessions.filter((botSession) => botSession.plan !== 'merchant')
    ).slice(0, 18);
    let html = `<html><body><title>Bot Party</title><font color="LEVEL">Available SimPlayers</font><br><br>`;

    candidates.forEach((candidate) => {
        const bot = candidate.bot;
        const status = BotManager.getBotStatus(candidate.session);
        const availability = candidate.availability;
        const memory = availability.memory;
        const action = availability.available
            ? `<a action="bypass -h bot-party invite ${bot.fetchName()}"><font color="00FF00">Invite</font></a>`
            : `<font color="777777">${availability.reasonText}</font>`;

        html += `<table width=270><tr>`;
        html += `<td width=165><font color="LEVEL">${bot.fetchName()}</font> Lv ${bot.fetchLevel()} ${status?.role || 'dps'}</td>`;
        html += `<td width=105 align=right>${action}</td>`;
        html += `</tr></table>`;
        html += `<font color="777777">${status?.mode || 'unknown'} / ${availability.relationship} / trust ${memory.trust} / dist ${dist(availability.distance)} / HP ${pct(status?.vitals?.hpPct)}</font><br>`;
        html += `<img src="L2UI.SquareBlank" width=270 height=5><br>`;
    });

    html += `<br><a action="bypass -h bot-party refresh">Refresh</a>`;
    html += `</body></html>`;
    session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), html));
}

function botParty(session, parts) {
    const actor = session.actor;
    if (!actor) return;

    if (parts[1] === 'invite' && parts[2]) {
        const botName = parts[2];
        const targetSession = BotManager.findSessionByName(botName);
        if (targetSession) {
            World.inviteBotCompanion(session, actor, targetSession, 1, 'botparty');
        }
    }

    render(session);
}

botParty.render = render;

module.exports = botParty;
