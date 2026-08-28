const ServerResponse = invoke('AuthenticationServer/Network/Response');
const ReceivePacket  = invoke('Packet/Receive');

function serverList(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // Session Key (first)
        .readD(); // Session Key (last)

    consume(session, {
        key1: packet.data[0],
        key2: packet.data[1],
    });
}

function consume(session, data) {
    if (utils.sessionMatch(session, data)) {
        session.dataSend(
            ServerResponse.serverList(options.default.GameServer, detectServerIPAddress(session).split('.'))
        );
    }
    else { // Session keys don't match
        session.dataSend(
            ServerResponse.loginFail(0x01)
        );
    }
}

function detectServerIPAddress(session) {
    const advertisedHostname = fetchAdvertisedHostname();
    if (advertisedHostname) {
        return advertisedHostname;
    }

    const remoteAddr = session.socket.remoteAddress;
    const host = remoteAddr.split('.');

    switch (host[0]) {
        case '10', '127': // Subnet, Localhost
            return remoteAddr;

        case '192': // LAN
            return utils.fetchIPv4Address();
    }

    // WAN / Internet
    utils.infoFail('AuthServer', 'unhandled WAN Address');
    return '';
}

function fetchAdvertisedHostname() {
    const configuredHostname = options.default.GameServer.advertisedHostname;
    if (configuredHostname === undefined || configuredHostname === null) {
        return '';
    }

    const hostname = String(configuredHostname).trim();
    if (!hostname) {
        return '';
    }

    const octets = hostname.split('.');
    const valid = octets.length === 4 && octets.every((octet) => {
        return /^\d{1,3}$/.test(octet) && Number(octet) <= 255;
    });

    if (!valid) {
        utils.infoWarn('AuthServer', 'invalid GameServer advertisedHostname: %s', hostname);
        return '';
    }

    return octets.map(Number).join('.');
}

module.exports = serverList;
