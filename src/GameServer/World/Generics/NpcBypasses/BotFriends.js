const BotFriendship = invoke('GameServer/Bot/AI/BotFriendship');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Html = invoke('GameServer/World/Generics/HtmlKit');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

function render(session, mode = 'friends', currentPage = 0) {
    const actor = session.actor;
    if (!actor) return;
    const isAdd = mode === 'add';
    const loader = isAdd ? BotFriendship.listCandidates(session, currentPage) : BotFriendship.listFriends(session, currentPage);
    Promise.all([loader, BotFriendship.selectedCount(session)]).then(([bots, selectedCount]) => {
        let body = `${Html.font(isAdd ? 'Add Bot Friend' : 'Bot Friends', Html.COLOR.title)}<br1>`;
        body += Html.font(isAdd ? 'Bots who know you, sorted by trust.' : 'Friends can be called from anywhere. Mark up to 8 for your const party.', Html.COLOR.muted) + '<br>';
        bots.forEach((bot) => {
            const action = isAdd
                ? (bot.trust >= BotFriendship.FRIEND_TRUST ? Html.link('Add friend', `bot-friends request ${bot.name} ${currentPage}`, { color: Html.COLOR.ok }) : Html.font(`trust ${bot.trust}/${BotFriendship.FRIEND_TRUST}`, Html.COLOR.muted))
                : Html.link(bot.selected ? 'Const: ON' : 'Const: OFF', `bot-friends const ${bot.botId} ${currentPage}`, { color: bot.selected ? Html.COLOR.ok : Html.COLOR.link });
            body += Html.table([Html.row([
                Html.cell(`${Html.font(bot.name, Html.COLOR.title)} Lv ${bot.level} ${bot.role}`, { width: 190 }),
                Html.cell(action, { width: 95, align: 'right' })
            ])]);
            body += Html.font(`${bot.activity || 'hunting'} / ${bot.currentRegion || 'unknown'} / trust ${bot.trust} / familiarity ${bot.familiarity}`, Html.COLOR.muted);
            body += '<br1>' + Html.line(Html.TEXTURE.blank, Html.WIDTH, 5);
        });
        if (!bots.length) body += Html.section('No Bots', Html.font(isAdd ? 'Run with bots to build trust first.' : 'No confirmed friends yet.', Html.COLOR.muted));
        const nav = currentPage > 0 ? Html.link('Previous', `bot-friends ${mode} ${currentPage - 1}`, { color: Html.COLOR.link }) : Html.font('Previous', Html.COLOR.muted);
        body += '<br>' + Html.columns([
            Html.cell(isAdd ? Html.link('My friends', 'bot-friends friends 0', { color: Html.COLOR.link }) : Html.link('Add friend', 'bot-friends add 0', { color: Html.COLOR.link }), { align: 'center' }),
            Html.cell(!isAdd && selectedCount > 0 ? Html.link('Form my party', 'bot-friends form', { color: Html.COLOR.ok }) : '', { align: 'center' }),
            Html.cell(nav, { align: 'center' }), Html.cell(Html.link('Next', `bot-friends ${mode} ${currentPage + 1}`, { color: Html.COLOR.link }), { align: 'center' })
        ]);
        session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), Html.page(body, { title: 'Bot Friends' })));
    });
}

function handler(session, parts) {
    const mode = parts[1] || 'friends';
    if (mode === 'request' && parts[2]) return LifeState.findByName(parts[2]).then((state) => BotFriendship.request(session, state).then(() => render(session, 'add', parts[3])));
    if (mode === 'const' && parts[2]) return BotFriendship.toggleConst(session, parts[2]).then(() => render(session, 'friends', parts[3]));
    if (mode === 'form') return BotFriendship.selected(session).then((bots) => bots.reduce((chain, bot) => chain.then(() => World.inviteFriendByName(session, session.actor, bot.characterName || bot.name, undefined, 'friend_const')), Promise.resolve()).then(() => render(session)));
    render(session, mode, parts[2]);
}
handler.render = render;
module.exports = handler;
