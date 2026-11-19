const BotFriendship = invoke('GameServer/Bot/AI/BotFriendship');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Html = invoke('GameServer/World/Generics/HtmlKit');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

function requestReasonText(reason) {
    return {
        low_trust: 'trust is still too low',
        insults: 'the bot remembers an insult',
        recently_abandoned: 'the bot needs a little time after the last abandonment',
        merchant_duty: 'this is a fixed service bot',
        missing_bot: 'the bot could not be found'
    }[reason] || 'the request was declined';
}

function render(session, mode = 'friends', currentPage = 0, notice = null, options = {}) {
    const actor = session.actor;
    if (!actor) return;
    if (session.nativePartyHubVersion) {
        const Hub = invoke('GameServer/World/Generics/NpcBypasses/NativePartyHub');
        return options.open ? Hub.open(session, mode === 'add' ? 'add' : 'friends') : Hub.render(session, notice?.message || '');
    }
    session.botFriendsView = { mode: mode === 'add' ? 'add' : 'friends', page: Math.max(0, Math.floor(Number(currentPage) || 0)) };
    if (session.nativeFriendsVersion === 1) {
        if (options.open) session.nativeFriendsOpen = true;
        return renderNative(session, options.open === true, notice?.message || '');
    }
    const isAdd = mode === 'add';
    const loader = isAdd ? BotFriendship.listCandidates(session, currentPage) : BotFriendship.listFriends(session, currentPage);
    return Promise.all([loader, BotFriendship.selectedCount(session)]).then(([bots, selectedCount]) => {
        if (session.actor !== actor || session.nativeFriendsVersion === 1) return;
        let body = `${Html.font(isAdd ? 'Add Bot Friend' : 'Bot Friends', Html.COLOR.title)}<br1>`;
        body += Html.font(isAdd ? 'Bots who know you, sorted by trust.' : 'Friends can be called from anywhere. Mark up to 8 for your const party.', Html.COLOR.muted) + '<br>';
        if (notice?.message) {
            body += Html.font(notice.message, notice.ok ? Html.COLOR.ok : Html.COLOR.warn) + '<br1>';
            body += Html.line(Html.TEXTURE.blank, Html.WIDTH, 5);
        }
        bots.forEach((bot) => {
            const profession = bot.className || 'Unknown profession';
            const trust = Number(bot.trust ?? 0).toFixed(1);
            const familiarity = Number(bot.familiarity ?? 0).toFixed(1);
            const action = isAdd
                ? (bot.trust >= BotFriendship.FRIEND_TRUST ? Html.link('Add friend', `bot-friends request ${bot.name} ${currentPage}`, { color: Html.COLOR.ok }) : Html.font(`trust ${trust}/${BotFriendship.FRIEND_TRUST}`, Html.COLOR.muted))
                : Html.link(bot.selected ? 'Const: ON' : 'Const: OFF', `bot-friends const ${bot.botId} ${currentPage}`, { color: bot.selected ? Html.COLOR.ok : Html.COLOR.link })
                    + '<br1>'
                    + Html.link('Remove', `bot-friends remove ${bot.botId} ${currentPage}`, { color: Html.COLOR.danger });
            body += Html.table([Html.row([
                Html.cell(`${Html.font(bot.name, Html.COLOR.title)}<br1>${Html.font(`Lv ${bot.level} ${profession}`, Html.COLOR.muted)} ${Html.font(bot.role, Html.COLOR.link)}`, { width: 190 }),
                Html.cell(action, { width: 95, align: 'right' })
            ])]);
            body += Html.font(`${bot.activity || 'hunting'} / ${bot.currentRegion || 'unknown'} / trust ${trust} / familiarity ${familiarity}`, Html.COLOR.muted);
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

async function renderNative(session, open = false, message = '') {
    if (!session.actor || !session.nativeFriendsOpen || session.nativeFriendsVersion !== 1) return;
    const actor = session.actor;
    const revision = session.nativeFriendsRevision = (session.nativeFriendsRevision || 0) + 1;
    const view = { ...(session.botFriendsView || { mode: 'friends', page: 0 }) };
    let result, selectedCount;
    try {
        [result, selectedCount] = await Promise.all([
            BotFriendship.listWindowPage(session, view.mode, view.page), BotFriendship.selectedCount(session)
        ]);
        if (!result.rows.length && view.page > 0) {
            view.page--;
            result = await BotFriendship.listWindowPage(session, view.mode, view.page);
        }
    } catch (error) {
        utils.infoWarn('BotFriends', 'native list failed: %s', error.message);
        result = { rows: [], hasNext: false }; selectedCount = 0;
        message = 'Could not load friends. Try Refresh.';
    }
    if (session.actor !== actor || !session.nativeFriendsOpen || session.nativeFriendsVersion !== 1 || session.nativeFriendsRevision !== revision) return;
    session.botFriendsView = view;
    session.nativeFriendsVisible = result.rows.map((bot) => ({ id: Number(bot.botId), name: bot.name }));
    session.nativeFriendsHasNext = result.hasNext;
    const Protocol = invoke('GameServer/World/Generics/NativeFriendsProtocol');
    session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), Protocol.encode({
        ...view, open, hasNext: result.hasNext, selectedCount, threshold: BotFriendship.FRIEND_TRUST,
        message
    }, result.rows)));
}

function handler(session, parts) {
    const mode = parts[1] || 'friends';
    const actor = session.actor;
    if (mode === 'request' && parts[2]) {
        // The friendship is the character's that asked; a character selected
        // during the lookup or the write neither owns it nor gets the page.
        return LifeState.findByName(parts[2]).then((state) => {
            if (session.actor !== actor) return;
            return BotFriendship.request(session, state).then((result) => {
                if (session.actor !== actor) return;
                const name = state?.name || parts[2];
                const message = result.ok
                    ? `${name} accepted your friend request.`
                    : `${name} declined the request: ${requestReasonText(result.reason)}.`;
                return render(session, 'add', parts[3], { ok: result.ok, message });
            });
        });
    }
    // The result page is for the character that asked, not one selected during the write.
    if (mode === 'remove' && parts[2]) {
        return BotFriendship.remove(session, parts[2]).then((result) => {
            if (session.actor !== actor) return;
            return render(session, 'friends', parts[3], {
                ok: result.ok,
                message: result.ok ? 'Friend removed. Social memory was kept.' : 'The friend could not be removed.'
            });
        });
    }
    if (mode === 'const' && parts[2]) {
        return BotFriendship.toggleConst(session, parts[2]).then(() => {
            if (session.actor !== actor) return;
            return render(session, 'friends', parts[3]);
        });
    }
    if (mode === 'form') {
        if (session.botFriendsForming) return;
        const operation = session.botFriendsForming = {};
        const current = () => session.actor === actor && session.botFriendsForming === operation;
        let formation, formationComplete = false;
        return BotFriendship.selected(session).then(async (bots) => {
            if (!current()) return;
            formation = await invoke('GameServer/Bot/AI/ConstPartySession').prepareFormation(session, actor, bots, current);
            for (const bot of bots) {
                if (!current()) return;
                await World.inviteFriendByName(session, actor, bot.characterName || bot.name, undefined, 'friend_const');
            }
            formationComplete = true;
            if (current()) return render(session);
        }).finally(async () => {
            try { if (formation && (!formationComplete || !current())) await formation.rollback(); }
            finally { if (session.botFriendsForming === operation) session.botFriendsForming = null; }
        });
    }
    render(session, mode, parts[2]);
}
handler.render = render;
handler.renderNative = renderNative;
handler.requestReasonText = requestReasonText;
module.exports = handler;
