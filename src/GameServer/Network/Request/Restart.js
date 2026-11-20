const ServerResponse = invoke('GameServer/Network/Response');
const Shared         = invoke('GameServer/Network/Shared');

async function restart(session, buffer) {
    if (session.characterLeaving) return;
    session.characterLeaving = true;
    session.characterSelection = (session.characterSelection || 0) + 1;
    const actor = session.actor;
    invoke('GameServer/World/Generics/NativeUiSession').reset(session, { clearDirection: true });

    invoke('GameServer/World/ArenaDuelService').release(session, 'restart');
    try {
        await session.persistCharacterStatus?.();
    } catch (error) {
        if (session.actor === actor) session.characterLeaving = false;
        throw error;
    }
    if (session.actor !== actor || session.socket?.destroyed) return;
    const World = invoke('GameServer/World/World');
    if (actor) {
        invoke('GameServer/Bot/BotTradeService').cleanup(session, 'restart');
        invoke('GameServer/Bot/AI/PartyCompanionService').detachAll(session, {
            event: 'party_disconnected', source: 'leader_disconnect',
            message: 'My companion disconnected. Returning to hunt.',
            rebuildWindow: false, refreshPanel: false
        });
        World.retireUserActor(session, actor);
        actor.setIsOnline?.(false);
        session.dataSendToOthers?.(ServerResponse.deleteOb(actor.fetchId()), actor);
        actor.destructor();
        session.actor = null;
    }

    session.dataSendToMe(
        ServerResponse.restart()
    );

    return Shared.fetchCharacters(session.accountId).then((characters) => {
        if (session.socket?.destroyed || session.actor) return;
        Shared.enterCharacterHall(session, characters);
    });
}

module.exports = restart;
