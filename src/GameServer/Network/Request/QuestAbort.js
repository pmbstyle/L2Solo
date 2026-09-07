const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');

function questAbort(session, buffer) {
    const packet = new ReceivePacket(buffer);
    packet.readD();
    const questId = Number(packet.data[0]);
    const QuestService = invoke('GameServer/Quest/QuestService');

    return QuestService.mutate(session, async () => {
        await QuestService.ensureLoaded(session);
        const state = session.questStates?.get(questId);
        if (state?.isStarted()) {
            if (state.quest.onAbort) await state.quest.onAbort(state);
            else await state.exit(true);
        }
        session.dataSendToMe(ServerResponse.questList(QuestService.active(session)));
    }).catch((error) => {
        utils.infoWarn('Quest', 'failed to abort quest: %s', error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    });
}

module.exports = questAbort;
