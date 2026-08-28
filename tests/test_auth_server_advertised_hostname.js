const assert = require('assert');

require('../src/Global');

const serverList = invoke('AuthenticationServer/Network/Request/ServerList');

function requestPacket(key1, key2) {
    const packet = Buffer.alloc(9);
    packet[0] = 0x05;
    packet.writeInt32LE(key1, 1);
    packet.writeInt32LE(key2, 5);
    return packet;
}

function advertisedAddress(remoteAddress) {
    const session = {
        key1: 101,
        key2: 202,
        socket: { remoteAddress },
        dataSend(packet) {
            this.sentPacket = packet;
        }
    };

    serverList(session, requestPacket(session.key1, session.key2));
    return Array.from(session.sentPacket.subarray(4, 8)).join('.');
}

const originalAdvertisedHostname = options.default.GameServer.advertisedHostname;
const originalInfoWarn = utils.infoWarn;

try {
    delete options.default.GameServer.advertisedHostname;
    assert.strictEqual(
        advertisedAddress('127.0.0.1'),
        '127.0.0.1',
        'default loopback address detection should remain unchanged'
    );

    options.default.GameServer.advertisedHostname = ' 100.92.15.42 ';
    assert.strictEqual(
        advertisedAddress('100.111.172.72'),
        '100.92.15.42',
        'explicit advertised hostname should override legacy Tailscale/WAN detection'
    );

    options.default.GameServer.advertisedHostname = '100.092.015.042';
    assert.strictEqual(
        advertisedAddress('100.111.172.72'),
        '100.92.15.42',
        'explicit IPv4 should be canonicalized before writing packet octets'
    );

    let warning = '';
    utils.infoWarn = (...parts) => {
        warning = parts.join(' ');
    };
    options.default.GameServer.advertisedHostname = 'pmbs-mac-mini.tailnet';
    assert.strictEqual(
        advertisedAddress('127.0.0.1'),
        '127.0.0.1',
        'invalid explicit hostname should fall back to legacy detection'
    );
    assert.match(warning, /invalid GameServer advertisedHostname/);
} finally {
    utils.infoWarn = originalInfoWarn;
    if (originalAdvertisedHostname === undefined) {
        delete options.default.GameServer.advertisedHostname;
    } else {
        options.default.GameServer.advertisedHostname = originalAdvertisedHostname;
    }
}

console.log('AuthServer advertised hostname tests passed');
