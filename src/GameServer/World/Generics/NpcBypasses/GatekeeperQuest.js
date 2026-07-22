const ServerResponse = invoke('GameServer/Network/Response');

module.exports = function gatekeeperQuest(session) {
    const active = session.activeNpcTalk;
    if (!active) return;

    const QuestService = invoke('GameServer/Quest/QuestService');
    const npc = {
        fetchSelfId: () => active.selfId,
        fetchId: () => active.objectId
    };
    QuestService.onTalk(session, npc).then((handled) => {
        if (handled) return;
        session.dataSendToMe(ServerResponse.npcHtml(active.objectId, '<html><body>There are no quests available.</body></html>'));
        session.dataSendToMe(ServerResponse.actionFailed());
    }).catch((error) => {
        utils.infoWarn('Quest', 'failed to open gatekeeper quest dialog: %s', error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    });
};
