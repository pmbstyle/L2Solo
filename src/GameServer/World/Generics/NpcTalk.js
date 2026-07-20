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

    // Quest dialogue has priority over generic NPC HTML.  The service loads
    // persistent state before selecting a quest, so an unrelated NPC keeps its
    // normal dialog while a quest NPC resumes exactly where the player stopped.
    const QuestService = invoke('GameServer/Quest/QuestService');
    if (!QuestService.handlesNpc(npc)) {
        showDefaultTalk(session, npc);
        return;
    }
    QuestService.onTalk(session, npc).then((handled) => {
        if (!handled) showDefaultTalk(session, npc);
    }).catch((error) => {
        utils.infoWarn('Quest', 'failed to open NPC quest dialog: %s', error.message);
        showDefaultTalk(session, npc);
    });
}

function showDefaultTalk(session, npc) {
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

    const C4GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
    const gatekeeperHtml = C4GatekeeperTeleports.html(npc.fetchSelfId());
    if (gatekeeperHtml) {
        session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), gatekeeperHtml));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    session.dataSendToMe(
        ServerResponse.npcHtml(npc.fetchId(), utils.parseRawFile(
            utils.fileExists(filename) ? filename : path + 'noquest.html'
        ))
    );
    // C4 keeps the interaction pending until the response is terminated.
    // Without this, closing the HTML leaves movement blocked while the NPC
    // remains selected.
    session.dataSendToMe(ServerResponse.actionFailed());
}

module.exports = npcTalk;
