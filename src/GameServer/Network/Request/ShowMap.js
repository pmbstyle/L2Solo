const ServerResponse = invoke('GameServer/Network/Response');

function showMap(session) {
    session.dataSendToMe(
        ServerResponse.showMap(1665)
    );
}

module.exports = showMap;
