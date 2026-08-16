'use strict';

const assert = require('assert');

require('../src/Global');

const CrumaTowerTeleports = invoke('GameServer/World/C4CrumaTowerTeleports');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const CrumaTowerTeleport = invoke('GameServer/World/Generics/NpcBypasses/CrumaTowerTeleport');

const expectedRoutes = [
    [7483, 21, [17724, 114004, -11672]],
    [7484, 22, [17192, 114178, -3439]],
    [7485, 24, [17714, 107923, -11850]],
    [7486, 55, [17719, 115590, -6584]],
    [7487, 23, [17730, 108301, -9057]],
    [12053, 57, [17719, 115590, -6584]],
    [12053, 22, [17192, 114178, -3439]]
];

for (const [npcId, teleportId, [locX, locY, locZ]] of expectedRoutes) {
    assert.deepStrictEqual(
        CrumaTowerTeleports.destination(npcId, teleportId),
        { locX, locY, locZ },
        `NPC ${npcId} must resolve Cruma teleport ${teleportId}`
    );
    assert.match(CrumaTowerTeleports.html(npcId), new RegExp(`cruma-tower-teleport ${teleportId}`));
}

assert.strictEqual(
    CrumaTowerTeleports.destination(7487, 24),
    null,
    'a first-floor return route must not be callable from the second-floor NPC'
);
assert.strictEqual(CrumaTowerTeleports.destination(7006, 21), null);
assert.strictEqual(CrumaTowerTeleports.html(7006), null);

const talkPackets = [];
NpcTalk(talkPacketsSession(), {
    fetchSelfId: () => 7487,
    fetchId: () => 9907487,
    fetchName: () => 'Gatekeeper Penelope',
    fetchTitle: () => 'Gatekeeper'
});
assert.strictEqual(talkPackets[0][0], 0x0f, 'Cruma gatekeeper talk must open teleport HTML');
assert.ok(talkPackets[0].includes(Buffer.from('cruma-tower-teleport 23', 'ucs2')));
assert.strictEqual(talkPackets[1][0], 0x25, 'Cruma gatekeeper talk must terminate the interaction packet sequence');

let teleported = null;
const originalInvoke = global.invoke;
global.invoke = function mockedInvoke(route) {
    if (route === path.actor) {
        return {
            teleportTo: (session, actor, destination) => {
                teleported = { session, actor, destination };
            }
        };
    }
    return originalInvoke(route);
};

try {
    const actor = {};
    const session = { actor, activeNpcTalk: { selfId: 7487, objectId: 9907487 } };
    CrumaTowerTeleport(session, ['cruma-tower-teleport', '23']);
    assert.strictEqual(teleported.session, session);
    assert.strictEqual(teleported.actor, actor);
    assert.deepStrictEqual(teleported.destination, { locX: 17730, locY: 108301, locZ: -9057 });

    const rejectedPackets = [];
    teleported = null;
    CrumaTowerTeleport({
        actor,
        activeNpcTalk: { selfId: 7487, objectId: 9907487 },
        dataSendToMe: (packet) => rejectedPackets.push(packet)
    }, ['cruma-tower-teleport', '24']);
    assert.strictEqual(teleported, null, 'a forged Cruma bypass must not teleport to another NPC route');
    assert.strictEqual(rejectedPackets[0][0], 0x25);
} finally {
    global.invoke = originalInvoke;
}

function talkPacketsSession() {
    return { dataSendToMe: (packet) => talkPackets.push(packet) };
}

console.log('C4 Cruma Tower teleport checks passed');
