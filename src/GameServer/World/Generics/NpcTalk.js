const ServerResponse = invoke('GameServer/Network/Response');

function npcTalk(session, npc) {
    const title = npc.fetchTitle?.() || '';

    session.activeNpcShop = null;
    session.activeNpcSellShop = null;
    session.activeNpcTalk = {
        selfId: npc.fetchSelfId(),
        objectId: npc.fetchId(),
        name: npc.fetchName(),
        title
    };

    const CrumaTowerTeleports = invoke('GameServer/World/C4CrumaTowerTeleports');
    const crumaTowerTeleportHtml = CrumaTowerTeleports.html(npc.fetchSelfId());
    if (crumaTowerTeleportHtml) {
        session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), crumaTowerTeleportHtml));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const SevenSignsDungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');
    const dungeonTeleportHtml = SevenSignsDungeonTeleports.html(npc.fetchSelfId());
    if (dungeonTeleportHtml) {
        session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), dungeonTeleportHtml));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const C4GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
    if (C4GatekeeperTeleports.html(npc.fetchSelfId())) {
        // A gatekeeper can simultaneously be a quest NPC.  Do not let quest
        // progress replace travel: offer the player both branches first.
        const QuestService = invoke('GameServer/Quest/QuestService');
        QuestService.hasTalk(session, npc).then((hasQuest) => {
            showGatekeeperTalk(session, npc, hasQuest);
        }).catch((error) => {
            utils.infoWarn('Quest', 'failed to inspect gatekeeper quests: %s', error.message);
            showGatekeeperTalk(session, npc, false);
        });
        return;
    }

    // A merchant can also be a quest NPC. Keep the merchant's main dialog
    // reachable; its Quest link is routed through NpcTalkResponse so the
    // quest service can still render the stateful branch on demand.
    const QuestService = invoke('GameServer/Quest/QuestService');
    const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
    const hasNpcShop = NpcShopBuyLists.fetchForNpc(npc.fetchSelfId()).length > 0;
    if (!QuestService.handlesNpc(npc) || hasNpcShop) {
        showDefaultTalk(session, npc, {
            questLink: hasNpcShop && QuestService.handlesNpc(npc)
        });
        return;
    }
    QuestService.onTalk(session, npc).then((handled) => {
        if (!handled) showDefaultTalk(session, npc);
    }).catch((error) => {
        utils.infoWarn('Quest', 'failed to open NPC quest dialog: %s', error.message);
        showDefaultTalk(session, npc);
    });
}

function showGatekeeperTalk(session, npc, hasQuest) {
    const C4GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
    session.dataSendToMe(ServerResponse.npcHtml(
        npc.fetchId(),
        C4GatekeeperTeleports.menu(npc.fetchSelfId(), hasQuest)
    ));
    session.dataSendToMe(ServerResponse.actionFailed());
}

function showDefaultTalk(session, npc, options = {}) {
    const path = 'data/Html/';
    const filename = path + npc.fetchSelfId() + '.html';
    const title = npc.fetchTitle?.() || '';
    if (/^Warehouse (Keeper|Chief|Freightman)$/i.test(title)) {
        session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), [
            '<html><body><center><br>Personal Warehouse<br><br>',
            '<a action="bypass -h warehouse deposit">Deposit item</a><br>',
            '<a action="bypass -h warehouse withdraw">Withdraw item</a>',
            '</center></body></html>'
        ].join('')));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    let html = utils.parseRawFile(
        utils.fileExists(filename) ? filename : path + 'noquest.html'
    );
    if (options.questLink) html = withQuestLink(html, npc.fetchSelfId());

    session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), html));
    // C4 keeps the interaction pending until the response is terminated.
    // Without this, closing the HTML leaves movement blocked while the NPC
    // remains selected.
    session.dataSendToMe(ServerResponse.actionFailed());
}

function withQuestLink(html, npcId) {
    const questAction = `<a action="bypass -h html ${npcId}-quest">Quest</a>`;
    const questLink = /<a action="bypass -h html (?:noquest|\d+-quest)">Quest<\/a>/i;
    if (questLink.test(html)) return html.replace(questLink, questAction);
    return html.replace(/<\/body>/i, `${questAction}<br>\n</body>`);
}

module.exports = npcTalk;
