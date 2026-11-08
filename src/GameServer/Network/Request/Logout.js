const ServerResponse = invoke('GameServer/Network/Response');

async function logout(session, buffer) {
    invoke('GameServer/World/Generics/NativeUiSession').reset(session, { clearDirection: true });

    invoke('GameServer/World/ArenaDuelService').release(session, 'logout');
    await session.persistCharacterStatus?.();
    invoke('GameServer/World/World').retireUserActor(session, session.actor);
    session.actor?.destructor();

    session.dataSendToMe(
        ServerResponse.logoutSuccess()
    );
}

module.exports = logout;
