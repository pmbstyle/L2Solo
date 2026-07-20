const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');

function questAbort(session, buffer) {
    const packet = new ReceivePacket(buffer);
    packet.readD();
    const questId = Number(packet.data[0]);
    const QuestService = invoke('GameServer/Quest/QuestService');

    QuestService.ensureLoaded(session).then(async () => {
        const state = session.questStates?.get(questId);
        if (state?.isStarted()) await state.exit(true);
        session.dataSendToMe(ServerResponse.questList(QuestService.active(session)));
    }).catch((error) => {
        utils.infoWarn('Quest', 'failed to abort quest: %s', error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    });
}

module.exports = questAbort;
