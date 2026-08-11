const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Html = invoke('GameServer/World/Generics/HtmlKit');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

const CANDIDATES_PER_PAGE = 8;

function pct(value) {
    return `${Math.round((value || 0) * 100)}%`;
}

function dist(value) {
    if (value === null || value === undefined) return '?';
    return `${Math.round(value)}`;
}

function pageNavigation(page, totalPages, candidateCount) {
    if (totalPages <= 1) return '';

    return '<br1>' + Html.columns([
        Html.cell(
            page > 0 ? Html.link('Previous', `bot-party page ${page - 1}`, { color: Html.COLOR.link }) : '',
            { width: 80, align: 'left' }
        ),
        Html.cell(Html.font(`Page ${page + 1}/${totalPages} (${candidateCount})`, Html.COLOR.muted), { width: 110, align: 'center' }),
        Html.cell(
            page + 1 < totalPages ? Html.link('Next', `bot-party page ${page + 1}`, { color: Html.COLOR.link }) : '',
            { width: 80, align: 'right' }
        )
    ]);
}

function render(session, requestedPage = 0) {
    const actor = session.actor;
    if (!actor) return;

    const candidates = BotAvailability.listForPlayer(
        session,
        BotManager.sessions.filter((botSession) => botSession.plan !== 'merchant')
    );
    const totalPages = Math.max(1, Math.ceil(candidates.length / CANDIDATES_PER_PAGE));
    const numericPage = Number(requestedPage);
    const page = Math.min(totalPages - 1, Math.max(0, Number.isFinite(numericPage) ? Math.floor(numericPage) : 0));
    const first = page * CANDIDATES_PER_PAGE;
    const visibleCandidates = candidates.slice(first, first + CANDIDATES_PER_PAGE);
    let body = `${Html.font('Available Bots', Html.COLOR.title)}<br1>`;
    body += `${Html.font('Active bots you can invite as real companions. Distant companions will catch up.', Html.COLOR.muted)}<br>`;

    visibleCandidates.forEach((candidate) => {
        const bot = candidate.bot;
        const status = BotManager.getBotStatus(candidate.session);
        const availability = candidate.availability;
        const memory = availability.memory;
        const action = availability.available
            ? Html.link('Invite', `bot-party invite ${bot.fetchName()} ${page}`, { color: Html.COLOR.ok })
            : Html.font(availability.reasonText, Html.COLOR.muted);
        const name = Html.font(bot.fetchName(), Html.COLOR.title);
        const profession = BotRoles.presentation(bot);
        const role = profession.role;
        const mode = status?.mode || 'unknown';
        const hp = pct(status?.vitals?.hpPct);
        const relationship = availability.relationship;
        const trust = memory.trust;
        const distance = dist(availability.distance);

        body += Html.table([
            Html.row([
                Html.cell(`${name}<br1>${Html.font(`Lv ${bot.fetchLevel()} ${profession.className || 'Unknown profession'}`, Html.COLOR.muted)} ${Html.font(role, Html.COLOR.link)}`, { width: 180 }),
                Html.cell(action, { width: 90, align: 'right' })
            ])
        ]);
        body += Html.font(`${mode} / ${relationship} / trust ${trust} / dist ${distance} / HP ${hp}`, Html.COLOR.muted);
        body += '<br1>' + Html.line(Html.TEXTURE.blank, Html.WIDTH, 5);
    });

    if (candidates.length === 0) {
        body += Html.section('No Candidates', Html.font('No available bots are visible right now.', Html.COLOR.muted));
    }

    body += pageNavigation(page, totalPages, candidates.length);
    body += '<br>' + Html.columns([
        Html.cell(Html.link('Refresh', `bot-party refresh ${page}`, { color: Html.COLOR.link }), { align: 'center' }),
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

    if (parts[1] === 'page' || parts[1] === 'refresh') {
        return render(session, parts[2]);
    }

    if (parts[1] === 'invite' && parts[2]) {
        const botName = parts[2];
        const targetSession = BotManager.findSessionByName(botName);
        if (targetSession) {
            World.inviteBotCompanion(session, actor, targetSession, undefined, 'botparty');
        }
        return render(session, parts[3]);
    }

    render(session);
}

botParty.render = render;
botParty.CANDIDATES_PER_PAGE = CANDIDATES_PER_PAGE;

module.exports = botParty;
