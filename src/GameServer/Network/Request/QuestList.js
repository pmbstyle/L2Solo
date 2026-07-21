const ServerResponse = invoke('GameServer/Network/Response');

function questList(session, buffer) {
    const QuestService = invoke('GameServer/Quest/QuestService');
    QuestService.ensureLoaded(session).then(() => {
        session.dataSendToMe(ServerResponse.questList(QuestService.active(session)));
    }).catch((error) => {
        utils.infoWarn('Quest', 'failed to load quest list: %s', error.message);
        session.dataSendToMe(ServerResponse.questList());
    });
}

module.exports = questList;
