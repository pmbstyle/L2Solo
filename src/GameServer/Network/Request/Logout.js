const ServerResponse = invoke('GameServer/Network/Response');

function logout(session, buffer) {

    invoke('GameServer/World/ArenaDuelService').release(session, 'logout');
    session.persistCharacterStatus?.();
    if (session.actor) invoke('GameServer/Effects/EffectTicker').clearAll(session.actor);
    session.actor?.destructor();

    session.dataSendToMe(
        ServerResponse.logoutSuccess()
    );
}

module.exports = logout;
