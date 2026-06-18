const BotManager = invoke('GameServer/Bot/BotManager');
const ServerResponse = invoke('GameServer/Network/Response');
const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Html = invoke('GameServer/World/Generics/HtmlKit');

function companionControl(session, parts) {
    const actor = session.actor;
    if (!actor || actor.isDead()) return;

    // Command parameters format:
    // companion-control <subcommand> <botname>
    const subCommand = parts[1];

    if (subCommand && subCommand !== 'refresh') {
        const botName = parts[2];
        if (botName) {
            const targetSession = BotManager.sessions.find(s => s.actor && s.actor.fetchName().toLowerCase() === botName.toLowerCase());
            
            if (targetSession && targetSession.followPlayerSession === session && targetSession.partyCompanion === true) {
                const bot = targetSession.actor;
                
                if (subCommand === 'follow') {
                    targetSession.botStay = false;
                    targetSession.stayLocation = null;
                    BotManager.botSay(targetSession, "Following you again!");
                }
                else if (subCommand === 'stay') {
                    targetSession.botStay = true;
                    targetSession.stayLocation = {
                        locX: bot.fetchLocX(),
                        locY: bot.fetchLocY(),
                        locZ: bot.fetchLocZ()
                    };
                    BotManager.botSay(targetSession, "Holding this position.");
                }
                else if (subCommand === 'taunt-on') {
                    targetSession.autoTaunt = true;
                    BotManager.botSay(targetSession, "Auto-taunt enabled. I will pull monsters.");
                }
                else if (subCommand === 'taunt-off') {
                    targetSession.autoTaunt = false;
                    BotManager.botSay(targetSession, "Auto-taunt disabled.");
                }
                else if (subCommand === 'summon') {
                    TeleportTo(targetSession, bot, {
                        locX: actor.fetchLocX() + 60,
                        locY: actor.fetchLocY() + 60,
                        locZ: actor.fetchLocZ()
                    });
                    if (targetSession.botStay) {
                        targetSession.stayLocation = {
                            locX: actor.fetchLocX() + 60,
                            locY: actor.fetchLocY() + 60,
                            locZ: actor.fetchLocZ()
                        };
                    }
                    BotManager.botSay(targetSession, "Summoned to your side!");
                }
                else if (subCommand === 'dismiss') {
                    session.dataSendToMe(ServerResponse.partySmallWindowDelete(bot.fetchId(), bot.fetchName()));
                    setTimeout(() => {
                        BotSocialMemory.recordEvent(session, targetSession, 'party_dismissed', 'companion_panel');
                        BotManager.botSay(targetSession, "Leaving the group. Goodbye!");
                        targetSession.plan = 'hunting';
                        targetSession.followPlayerSession = null;
                        targetSession.partyCompanion = false;
                        targetSession.botStay = false;
                        targetSession.stayLocation = null;
                    }, 1000);
                }
            }
        }
    }

    // Always redraw the panel
    renderCompanionPanel(session);
}

function renderCompanionPanel(session) {
    const actor = session.actor;
    if (!actor) return;

    // Find all bot sessions following this player
    const myCompanions = BotManager.sessions.filter(s => s.followPlayerSession === session && s.partyCompanion === true && s.actor);

    if (myCompanions.length === 0) {
        const html = Html.page(
            Html.emptyState(
                'Companion Panel',
                'You currently have no companions in your party. Target a bot and type /invite to recruit them.'
            ),
            { title: 'Party Control' }
        );
        session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), html));
        return;
    }

    let body = `${Html.font('Companion Commands', Html.COLOR.title)}<br>`;

    myCompanions.forEach((companionSession) => {
        const bot = companionSession.actor;
        const isTank = BotRoles.isTank(bot);

        const stayActive = companionSession.botStay === true;
        const tauntActive = companionSession.autoTaunt !== false; // default true for tanks
        const status = BotManager.getBotStatus(companionSession);
        const hpPct = status ? Math.round(status.vitals.hpPct * 100) : 0;
        const mpPct = status ? Math.round(status.vitals.mpPct * 100) : 0;
        const spotName = status?.spot?.name || 'no spot';
        const roleDecision = status?.roleDecision ? `${status.roleDecision.action}/${status.roleDecision.reason}` : status?.intent;

        const movement = stayActive
            ? Html.link('[STAYING]', `companion-control follow ${bot.fetchName()}`, { color: Html.COLOR.danger })
            : Html.link('[FOLLOWING]', `companion-control stay ${bot.fetchName()}`, { color: Html.COLOR.ok });
        let actions = movement;

        if (isTank) {
            const taunt = tauntActive
                ? Html.link('[PULL: ON]', `companion-control taunt-off ${bot.fetchName()}`, { color: Html.COLOR.title })
                : Html.link('[PULL: OFF]', `companion-control taunt-on ${bot.fetchName()}`, { color: Html.COLOR.muted });
            actions += ` | ${taunt}`;
        }

        actions += ` | ${Html.link('Summon', `companion-control summon ${bot.fetchName()}`)}`;
        actions += ` | ${Html.link('Status', `bot-status ${bot.fetchName()}`)}`;
        actions += ` | ${Html.link('Dismiss', `companion-control dismiss ${bot.fetchName()}`, { color: Html.COLOR.danger })}`;

        body += Html.botCard({
            name: bot.fetchName(),
            badge: status ? Html.font(status.role || 'bot', Html.COLOR.link) : '',
            subtitle: status ? `${roleDecision} / HP ${hpPct}% / MP ${mpPct}% / ${spotName}` : 'status unavailable',
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
