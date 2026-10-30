const assert = require('assert');
require('../src/Global');

const receiveMove = invoke('GameServer/Network/Request/MoveToLocation');
const moveTo = invoke('GameServer/Actor/Generics/MoveTo');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const packets = [];
const session = {
    accountId: 'player_height_test',
    dataSendToMeAndOthers(packet) { packets.push(packet); }
};
const actor = session.actor = {
    effects: {},
    isDead: () => false,
    isBlocked: () => false,
    fetchId: () => 2000224,
    fetchSize: () => 23,
    automation: { abortAll() {} },
    moveTo(coords) { moveTo(session, actor, coords); }
};

function request(destination, source, mode = 1) {
    const packet = Buffer.alloc(29);
    packet[0] = 1;
    [...destination, ...source, mode].forEach((value, index) => packet.writeInt32LE(value, 1 + index * 4));
    receiveMove(session, packet);
    const response = packets.pop();
    assert.strictEqual(response[0], 1);
    return Array.from({ length: 7 }, (_, index) => response.readInt32LE(1 + index * 4));
}

// Exercise the real request -> player movement -> response packet path.
// These are protocol fixtures, not captured clicks from the live client.
const originalHasGeo = GeodataEngine.hasGeo;
try {
    GeodataEngine.hasGeo = () => false;
    for (const mode of [0, 1]) {
        assert.deepStrictEqual(request([146240, 28238, -2271], [146309, 28238, -2259], mode),
            [2000224, 146240, 28238, -2248, 146309, 28238, -2259]);
    }
    actor.fetchSize = () => 23.5;
    assert.strictEqual(request([100, 200, -100], [10, 20, -70])[3], -76,
        'C4 integer destination uses Java compound-assignment truncation after adding height');
} finally {
    GeodataEngine.hasGeo = originalHasGeo;
}

moveTo(session, actor, { from: { locX: 10, locY: 20, locZ: -70 }, to: { locX: 100, locY: 200, locZ: -76 } });
assert.strictEqual(packets.pop().readInt32LE(13), -76, 'Server-generated actor Z must not be corrected twice');

const originalGeo = Object.fromEntries(['getCellData', 'hasGeo', 'hasLineOfSight'].map(key => [key, GeodataEngine[key]]));
try {
    actor.fetchSize = () => 23;
    let covered = true;
    let reachable = true;
    let endHeight = -2248;
    GeodataEngine.getCellData = (x, y, z) => ({ z: y >= 28800 ? endHeight : -2256, nswe: 15 });
    GeodataEngine.hasGeo = () => covered;
    GeodataEngine.hasLineOfSight = () => reachable;
    const source = [148240, 28731, -2259];
    const destination = [148240, 28840, -2281];
    assert.deepStrictEqual(request(destination, source), [2000224, 148240, 28840, -2248, ...source],
        'The outgoing target must use the reachable geo layer after adding collision height; source stays client-reported');
    covered = false;
    assert.strictEqual(request(destination, source)[3], -2258, 'Missing geo preserves the C4 floor conversion');
    covered = true;
    reachable = false;
    assert.strictEqual(request(destination, source)[3], -2258, 'A blocked segment must not acquire a corrected destination on the other side');
    reachable = true;
    endHeight = -1888;
    assert.strictEqual(request(destination, source)[3], -2258, 'Do not snap a click to a remote upper layer');
    endHeight = -2248;
    actor.stateWater = true;
    assert.strictEqual(request(destination, source)[3], -2258, 'Swimming must retain client Z');
    actor.stateWater = false;
    actor.isFlying = () => true;
    assert.strictEqual(request(destination, source)[3], -2258, 'Flying must retain client Z');
    delete actor.isFlying;
    actor.boatId = 123;
    assert.strictEqual(request(destination, source)[3], -2258, 'Vehicle movement must retain client Z');
    delete actor.boatId;
} finally {
    Object.assign(GeodataEngine, originalGeo);
}

require('./helpers/verify_geodata_when_available')(GeodataEngine, [[24, 18]], 'Aden doorway centres', () => {
    for (const [x, y, z, dx, dy] of [
        [146309, 28238, -2259, -64, 0],
        [146668, 28730, -2259, 0, 64],
        [148240, 28731, -2259, 0, 64],
        [148602, 28244, -2259, 64, 0],
        [148604, 26971, -2193, 64, 0]
    ]) {
        const endZ = GeodataEngine.getHeight(x + dx, y + dy, z);
        assert(GeodataEngine.hasLineOfSight(x, y, z, x + dx, y + dy, endZ), `Doorway ${x},${y} ingress`);
        assert(GeodataEngine.hasLineOfSight(x + dx, y + dy, endZ, x, y, z), `Doorway ${x},${y} egress`);
    }
    // Actual source/target coordinates from the failed post-restart movement trace.
    const destinationZ = GeodataEngine.getHeight(148255, 28865, -2281 + actor.fetchSize());
    assert(Math.abs(destinationZ - (-2281 + actor.fetchSize())) <= 64);
    assert.deepStrictEqual(request([148255, 28865, -2281], [148262, 28731, -2259]),
        [2000224, 148255, 28865, destinationZ, 148262, 28731, -2259]);
});

require('./helpers/verify_geodata_when_available')(GeodataEngine, [[23, 20]], 'Additional player-reported transition', () => {
    const destinationZ = GeodataEngine.getHeight(116069, 75553, -2693 + actor.fetchSize());
    assert(Math.abs(destinationZ - (-2693 + actor.fetchSize())) <= 64);
    assert.deepStrictEqual(request([116069, 75553, -2693], [116126, 75622, -2713]),
        [2000224, 116069, 75553, destinationZ, 116126, 75622, -2713]);
});

console.log('Player movement destination height checks passed');
