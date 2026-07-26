const BotManager = invoke('GameServer/Bot/BotManager');
const ServerResponse = invoke('GameServer/Network/Response');
const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotStatus = invoke('GameServer/Bot/AI/BotStatus');
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

function isAssignedPuller(targetSession, settings = PartyCompanionService.getSettings(targetSession?.followPlayerSession)) {
    return settings?.pullMode === 'bot' &&
        Number(settings.pullerId || 0) === Number(targetSession?.actor?.fetchId?.());
}

function stopPullAction(targetSession) {
    const bot = targetSession?.actor;
    if (!bot) return;
    bot.attack?.abortCast?.(targetSession, bot);
    bot.attack?.clearTimers?.();
    bot.state?.setHits?.(false);
    bot.state?.setCasts?.(false);
    bot.automation?.abortAll?.(bot);
    targetSession.currentTargetId = undefined;
    bot.unselect?.();
}

function assignedPullerSession(session) {
    const settings = PartyCompanionService.getSettings(session);
    return companionSessions(session).find((memberSession) => isAssignedPuller(memberSession, settings)) || null;
}

function clearAssignedPuller(session) {
    const settings = PartyCompanionService.getSettings(session);
    if (settings.pullMode !== 'bot') return false;

    stopPullAction(assignedPullerSession(session));
    PartyCompanionService.updateSettings(session, { pullMode: 'auto', pullerId: null });
    session.partyPullState = {};
    companionSessions(session).forEach((memberSession) => {
        memberSession.partyPuller = false;
    });
    return true;
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
    if (mode === 'hold') clearAssignedPuller(session);
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
    const allowed = ['auto', 'leader', 'off'];
    const pullMode = allowed.includes(mode) ? mode : 'auto';
    stopPullAction(assignedPullerSession(session));
    PartyCompanionService.updateSettings(session, { pullMode, pullerId: null });
    session.partyPullState = {};
    companionSessions(session).forEach((memberSession) => {
        memberSession.autoTaunt = pullMode !== 'off';
        memberSession.partyPuller = false;
        memberSession.currentTargetId = undefined;
        memberSession.actor?.unselect?.();
    });
}

function setMemberPuller(session, targetSession) {
    const role = BotRoles.inferRole(targetSession?.actor);
    if (!['tank', 'dagger', 'dps'].includes(role)) return false;

    const previousPuller = assignedPullerSession(session);
    if (previousPuller && previousPuller !== targetSession) stopPullAction(previousPuller);
    PartyCompanionService.updateSettings(session, {
        pullMode: 'bot',
        pullerId: targetSession.actor.fetchId()
    });
    session.partyPullState = {};
    companionSessions(session).forEach((memberSession) => {
        memberSession.partyPuller = memberSession === targetSession;
        memberSession.autoTaunt = true;
        if (memberSession === targetSession) followLeader(memberSession);
    });
    BotManager.botSay(targetSession, "I'll pull the next mobs to the party.");
    return true;
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
        if (isAssignedPuller(targetSession)) clearAssignedPuller(session);
        followLeader(targetSession);
        BotManager.botSay(targetSession, "Following you again!");
    } else if (subCommand === 'stay') {
        if (isAssignedPuller(targetSession)) clearAssignedPuller(session);
        stayHere(targetSession);
        BotManager.botSay(targetSession, "Holding this position.");
    } else if (subCommand === 'summon') {
        summonNear(session, targetSession);
        BotManager.botSay(targetSession, "Summoned to your side!");
    } else if (subCommand === 'dismiss') {
        PartyCompanionService.detach(session, targetSession, {
            event: 'party_kicked',
            source: 'panel',
            message: 'Leaving the party. Good luck out there!'
        });
    }
}

function compactText(value, fallback = 'idle') {
    return String(value || fallback)
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 32);
}

function lootLabel(distribution) {
    return ({
        0: 'Finders',
        1: 'Random',
        2: 'Random+Spoil',
        3: 'By Turn',
        4: 'Turn+Spoil'
    })[distribution] || `Native #${distribution}`;
}

function actionRow(items, options = {}) {
    const columns = options.columns || items.length;
    const width = Math.floor(Html.WIDTH / columns);
    const cells = [];
    for (let i = 0; i < columns; i++) {
        const item = items[i];
        if (!item) {
            cells.push(Html.cell('', { width, align: 'center' }));
            continue;
        }
        cells.push(Html.cell(Html.link(item.label, item.command, {
            color: item.active ? Html.COLOR.title : (item.color || Html.COLOR.link)
        }), { width, align: 'center' }));
    }
    return Html.table([Html.row(cells)]);
}

function renderModePanel(settings, count) {
    const title = `${Html.font('Party Control', Html.COLOR.title)} ${Html.font(`${count} active`, Html.COLOR.ok)}`;
    const summary = [
        `Combat ${settings.combatMode}`,
        `Move ${settings.movementMode === 'hold' ? 'hold' : 'follow'}`,
        `Pull ${({ auto: 'auto', bot: 'bot', leader: 'player', off: 'off' })[settings.pullMode] || 'auto'}`
    ].join(' / ');

    return [
        Html.table([
            Html.row([
                Html.cell(title, { width: Html.WIDTH, align: 'center' })
            ]),
            Html.row([
                Html.cell(Html.font(summary, Html.COLOR.muted), { width: Html.WIDTH, align: 'center' })
            ])
        ]),
        actionRow([
            { label: 'Refresh', command: 'companion-control refresh', color: Html.COLOR.muted }
        ], { columns: 1 }),
        Html.font('Combat', Html.COLOR.muted),
        actionRow([
            { label: 'Assist', active: settings.combatMode === 'assist', command: 'companion-control combat assist' },
            { label: 'Protect', active: settings.combatMode === 'protect', command: 'companion-control combat protect' },
            { label: 'Passive', active: settings.combatMode === 'passive', command: 'companion-control combat passive' }
        ]),
        Html.font('Move', Html.COLOR.muted),
        actionRow([
            { label: 'Follow', active: settings.movementMode !== 'hold', command: 'companion-control movement follow' },
            { label: 'Hold', active: settings.movementMode === 'hold', command: 'companion-control movement hold' },
            { label: 'Regroup', command: 'companion-control regroup', color: Html.COLOR.ok }
        ]),
        Html.font('Pull', Html.COLOR.muted),
        actionRow([
            { label: 'Auto', active: settings.pullMode === 'auto', command: 'companion-control pull auto' },
            { label: 'Player', active: settings.pullMode === 'leader', command: 'companion-control pull leader' },
            { label: 'Off', active: settings.pullMode === 'off', command: 'companion-control pull off' }
        ], { columns: 3 }),
        Html.font(`Loot: ${lootLabel(settings.distribution)}`, Html.COLOR.muted),
        '<br1>'
    ].join('');
}

function renderCompanionCard(companionSession, settings) {
    const bot = companionSession.actor;
    const isPuller = isAssignedPuller(companionSession, settings);
    const stayActive = companionSession.botStay === true;
    const status = BotManager.getBotStatus(companionSession);
    const role = status?.role || BotRoles.inferRole(bot);
    const stance = isPuller ? 'pulling' : (stayActive ? 'hold' : 'follow');
    const intent = compactText(status?.intent || companionSession.plan, 'idle');
    const tacticalDecision = status?.decisions?.pvp
        ? BotStatus.decisionSummary(status.decisions.pvp, 'pvp')
        : status?.decisions?.combat
            ? BotStatus.decisionSummary(status.decisions.combat, 'combat')
            : null;
    const roleDecision = status?.roleDecision
        ? compactText(`${status.roleDecision.action}/${status.roleDecision.reason}`)
        : compactText(tacticalDecision, intent);
    const target = status?.target
        ? compactText(status.target.name || status.target.id, 'target')
        : null;
    const blocker = status?.blockers?.[0]
        ? compactText(status.blockers[0])
        : null;
    const buffWarning = status?.buffs?.needsRefresh ? 'buffs low' : null;
    const debuff = status?.debuffs?.[0]?.key ? `debuff ${status.debuffs[0].key}` : null;
    const targetEvaluation = status?.decisions?.target
        ? compactText(BotStatus.decisionSummary(status.decisions.target, 'target'))
        : null;
    const note = blocker || debuff || buffWarning || targetEvaluation || target || 'ready';
    const noteColor = blocker || debuff ? Html.COLOR.warn : Html.COLOR.muted;
    const canPull = ['tank', 'dagger', 'dps'].includes(role);
    const primaryAction = stayActive
        ? { label: 'Follow', command: `companion-control follow ${bot.fetchName()}`, color: Html.COLOR.ok }
        : { label: 'Hold', command: `companion-control stay ${bot.fetchName()}` };

    const summary = Html.table([
        Html.row([
            Html.cell(`${Html.font(bot.fetchName(), Html.COLOR.ok)} ${Html.font(`Lv ${bot.fetchLevel()} ${role}`, Html.COLOR.link)}`, { width: 186 }),
            Html.cell(Html.font(stance, stance === 'follow' ? Html.COLOR.ok : Html.COLOR.warn), { width: 84, align: 'right' })
        ]),
        Html.row([
            Html.cell(Html.font('Order', Html.COLOR.muted), { width: 54 }),
            Html.cell(Html.font(roleDecision, Html.COLOR.title), { width: 216, align: 'left' })
        ]),
        Html.row([
            Html.cell(Html.font('State', Html.COLOR.muted), { width: 54 }),
            Html.cell(Html.font(note, noteColor), { width: 216, align: 'left' })
        ])
    ]);

    const actions = actionRow([
        primaryAction,
        canPull
            ? (isPuller
                ? { label: 'Stop Pull', command: `companion-control member-pull off ${bot.fetchName()}`, color: Html.COLOR.warn }
                : { label: 'Pull', command: `companion-control member-pull on ${bot.fetchName()}`, color: Html.COLOR.ok })
            : null,
        { label: 'Call', command: `companion-control summon ${bot.fetchName()}` },
        { label: 'Info', command: `bot-status ${bot.fetchName()}` },
        { label: 'Dismiss', command: `companion-control dismiss ${bot.fetchName()}`, color: Html.COLOR.warn }
    ], { columns: 5 });

    return `${Html.line(Html.TEXTURE.line, Html.WIDTH, 1)}${summary}${actions}<br1>`;
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
    } else if (subCommand === 'member-pull') {
        const targetSession = findCompanion(session, parts[3]);
        if (value === 'on' && targetSession) {
            setMemberPuller(session, targetSession);
        } else if (value === 'off' && targetSession && isAssignedPuller(targetSession)) {
            clearAssignedPuller(session);
            BotManager.botSay(targetSession, 'Stopping pull duty and staying with the party.');
        }
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

    let body = renderModePanel(settings, myCompanions.length);
    body += Html.spacer(5);

    myCompanions.forEach((companionSession) => {
        body += renderCompanionCard(companionSession, settings);
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
