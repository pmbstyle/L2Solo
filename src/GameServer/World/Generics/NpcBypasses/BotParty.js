const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotManager = invoke('GameServer/Bot/BotManager');
const Html = invoke('GameServer/World/Generics/HtmlKit');
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
    let body = `${Html.font('Available SimPlayers', Html.COLOR.title)}<br1>`;
    body += `${Html.font('Nearby bots you can invite as real companions.', Html.COLOR.muted)}<br>`;

    candidates.forEach((candidate) => {
        const bot = candidate.bot;
        const status = BotManager.getBotStatus(candidate.session);
        const availability = candidate.availability;
        const memory = availability.memory;
        const action = availability.available
            ? Html.link('Invite', `bot-party invite ${bot.fetchName()}`, { color: Html.COLOR.ok })
            : Html.font(availability.reasonText, Html.COLOR.muted);
        const name = Html.font(bot.fetchName(), Html.COLOR.title);
        const role = status?.role || 'dps';
        const mode = status?.mode || 'unknown';
        const hp = pct(status?.vitals?.hpPct);
        const relationship = availability.relationship;
        const trust = memory.trust;
        const distance = dist(availability.distance);

        body += Html.table([
            Html.row([
                Html.cell(`${name} Lv ${bot.fetchLevel()} ${Html.font(role, Html.COLOR.link)}`, { width: 180 }),
                Html.cell(action, { width: 90, align: 'right' })
            ])
        ]);
        body += Html.font(`${mode} / ${relationship} / trust ${trust} / dist ${distance} / HP ${hp}`, Html.COLOR.muted);
        body += '<br1>' + Html.line(Html.TEXTURE.blank, Html.WIDTH, 5);
    });

    if (candidates.length === 0) {
        body += Html.section('No Candidates', Html.font('No available SimPlayers are visible right now.', Html.COLOR.muted));
    }

    body += '<br>' + Html.columns([
        Html.cell(Html.link('Refresh', 'bot-party refresh', { color: Html.COLOR.link }), { align: 'center' }),
        Html.cell(Html.link('Close', 'bot-party close', { color: Html.COLOR.muted }), { align: 'center' })
    ]);

    const html = Html.page(body, { title: 'Bot Party' });
    session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), html));
}

function botParty(session, parts) {
    const actor = session.actor;
    if (!actor) return;

    if (parts[1] === 'close') {
        return;
    }

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
