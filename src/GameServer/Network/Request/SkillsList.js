const ServerResponse = invoke('GameServer/Network/Response');

function skillsList(session, buffer) {
    session.dataSendToMe(ServerResponse.exStorageMaxCount(session.actor));
    session.dataSendToMe(
        ServerResponse.skillsList(session.actor.skillset.fetchSkills())
    );
}

module.exports = skillsList;
