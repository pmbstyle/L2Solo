const BotManager = invoke('GameServer/Bot/BotManager');
const ServerResponse = invoke('GameServer/Network/Response');
const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Html = invoke('GameServer/World/Generics/HtmlKit');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

function companionSessions(session) {
    return PartyCompanionService.membersForLeader(session);
}

function findCompanion(session, botName) {
    const lookup = String(botName || '').trim().toLowerCase();
    if (!lookup) return null;
    return companionSessions(session).find((targetSession) => (
        targetSession.actor &&
        targetSession.actor.fetchName().toLowerCase() === lookup
    )) || null;
}

function stayHere(targetSession) {
    const bot = targetSession.actor;
    targetSession.botStay = true;
    targetSession.stayLocation = {
        locX: bot.fetchLocX(),
        locY: bot.fetchLocY(),
        locZ: bot.fetchLocZ()
    };
}

function followLeader(targetSession) {
    targetSession.botStay = false;
    targetSession.stayLocation = null;
}

function summonNear(session, targetSession, offset = 60) {
    const actor = session.actor;
    const bot = targetSession.actor;
    const loc = {
        locX: actor.fetchLocX() + offset,
        locY: actor.fetchLocY() + offset,
        locZ: actor.fetchLocZ()
    };
    TeleportTo(targetSession, bot, loc);
    if (targetSession.botStay) {
        targetSession.stayLocation = loc;
    }
}

function setMovementMode(session, mode) {
    const members = companionSessions(session);
    PartyCompanionService.updateSettings(session, { movementMode: mode });
    members.forEach((memberSession) => {
        if (mode === 'hold') {
            stayHere(memberSession);
        } else {
            followLeader(memberSession);
        }
    });
}

function setCombatMode(session, mode) {
    const allowed = ['assist', 'protect', 'passive'];
    if (!allowed.includes(mode)) return;
    PartyCompanionService.updateSettings(session, { combatMode: mode });
    companionSessions(session).forEach((memberSession) => {
        memberSession.currentTargetId = undefined;
        memberSession.actor?.unselect?.();
    });
}

function setPullMode(session, mode) {
    const pullMode = mode === 'off' ? 'off' : 'auto';
    PartyCompanionService.updateSettings(session, { pullMode });
    companionSessions(session).forEach((memberSession) => {
        memberSession.autoTaunt = pullMode !== 'off';
    });
}

function regroup(session) {
    companionSessions(session).forEach((memberSession, index) => {
        summonNear(session, memberSession, 60 + (index * 20));
    });
}

function handleMemberCommand(session, subCommand, botName) {
    const targetSession = findCompanion(session, botName);
    if (!targetSession) return;

    if (subCommand === 'follow') {
        followLeader(targetSession);
        BotManager.botSay(targetSession, "Following you again!");
    } else if (subCommand === 'stay') {
        stayHere(targetSession);
        BotManager.botSay(targetSession, "Holding this position.");
    } else if (subCommand === 'summon') {
        summonNear(session, targetSession);
        BotManager.botSay(targetSession, "Summoned to your side!");
    }
}

function companionControl(session, parts) {
    const actor = session.actor;
    if (!actor || actor.isDead()) return;

    const subCommand = parts[1];
    const value = parts[2];

    if (subCommand === 'movement') {
        setMovementMode(session, value === 'hold' ? 'hold' : 'follow');
    } else if (subCommand === 'combat') {
        setCombatMode(session, value);
    } else if (subCommand === 'pull') {
        setPullMode(session, value);
    } else if (subCommand === 'regroup') {
        regroup(session);
    } else if (subCommand && subCommand !== 'refresh') {
        handleMemberCommand(session, subCommand, value);
    }

    renderCompanionPanel(session);
}

function renderCompanionPanel(session) {
    const actor = session.actor;
    if (!actor) return;

    const myCompanions = PartyCompanionService.membersForLeader(session);
    const settings = PartyCompanionService.getSettings(session);

    if (myCompanions.length === 0) {
        const html = Html.page(
            Html.emptyState(
                'Party Control',
                'No companions are currently in this party.'
            ),
            { title: 'Party Control' }
        );
        session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), html));
        return;
    }

    const modeLink = (label, active, command) => Html.link(active ? `[${label}]` : label, command, {
        color: active ? Html.COLOR.title : Html.COLOR.link
    });

    let body = `${Html.font('Party Control', Html.COLOR.title)}<br1>`;
    body += Html.statusTable([
        ['Loot', Html.font(`native #${settings.distribution}`, Html.COLOR.muted)],
        ['Combat', [
            modeLink('Assist', settings.combatMode === 'assist', 'companion-control combat assist'),
            modeLink('Protect', settings.combatMode === 'protect', 'companion-control combat protect'),
            modeLink('Passive', settings.combatMode === 'passive', 'companion-control combat passive')
        ].join(' ')],
        ['Move', [
            modeLink('Follow', settings.movementMode !== 'hold', 'companion-control movement follow'),
            modeLink('Hold', settings.movementMode === 'hold', 'companion-control movement hold')
        ].join(' ')],
        ['Pull', [
            modeLink('Auto', settings.pullMode !== 'off', 'companion-control pull auto'),
            modeLink('Off', settings.pullMode === 'off', 'companion-control pull off')
        ].join(' ')]
    ]);
    body += Html.actionFooter([
        { label: 'Regroup', command: 'companion-control regroup', color: Html.COLOR.link },
        { label: 'Refresh', command: 'companion-control refresh', color: Html.COLOR.muted }
    ]);
    body += Html.spacer(5);

    myCompanions.forEach((companionSession) => {
        const bot = companionSession.actor;
        const stayActive = companionSession.botStay === true;
        const status = BotManager.getBotStatus(companionSession);
        const hpPct = status ? Math.round(status.vitals.hpPct * 100) : 0;
        const mpPct = status ? Math.round(status.vitals.mpPct * 100) : 0;
        const roleDecision = status?.roleDecision ? `${status.roleDecision.action}/${status.roleDecision.reason}` : status?.intent;
        const buffText = status?.buffs?.needsRefresh ? ' / buffs low' : '';
        const stance = stayActive ? 'hold' : 'follow';
        const pullText = BotRoles.isTank(bot) ? ` / pull ${companionSession.autoTaunt === false ? 'off' : 'auto'}` : '';
        const actions = [
            stayActive
                ? Html.link('Follow', `companion-control follow ${bot.fetchName()}`, { color: Html.COLOR.link })
                : Html.link('Hold', `companion-control stay ${bot.fetchName()}`, { color: Html.COLOR.link }),
            Html.link('Summon', `companion-control summon ${bot.fetchName()}`),
            Html.link('Status', `bot-status ${bot.fetchName()}`)
        ].join(' | ');

        body += Html.botCard({
            name: bot.fetchName(),
            badge: status ? Html.font(status.role || 'bot', Html.COLOR.link) : '',
            subtitle: status ? `${roleDecision} / ${stance}${pullText} / HP ${hpPct}% / MP ${mpPct}%${buffText}` : 'status unavailable',
            status: actions
        });
        body += Html.spacer(4);
    });

    body += Html.actionFooter([
        { label: 'Close Panel', command: 'html 7000', color: Html.COLOR.muted }
    ]);

    const html = Html.page(body, { title: 'Party Control' });
    session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), html));
}

companionControl.render = renderCompanionPanel;

module.exports = companionControl;
