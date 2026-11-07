const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotSession = invoke('GameServer/Bot/BotSession');
const Actor = invoke('GameServer/Actor/Actor');
const broadcastVitals = invoke('GameServer/Npc/Generics/BroadcastVitals');
const Frame = invoke('Packet/Frame');

let actorId = 9800000;
function actorAt(x, y, online = true) {
    const id = ++actorId;
    return {
        fetchId: () => id,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => 0,
        fetchIsOnline: () => online
    };
}

const originalUser = World.user;
const source = new BotSession('bot_source');
source.actor = actorAt(0, 0);
const visiblePlayer = {
    accountId: 'player_visible',
    fetchAccountId() { return this.accountId; },
    actor: actorAt(100, 100)
};
const visibleBot = new BotSession('bot_visible');
visibleBot.actor = actorAt(-100, -100);
const boundaryPlayer = {
    accountId: 'player_boundary',
    fetchAccountId() { return this.accountId; },
    actor: actorAt(6000, 0)
};
const offlinePlayer = {
    accountId: 'player_offline',
    fetchAccountId() { return this.accountId; },
    actor: actorAt(100, 100, false)
};
// Records what reaches a player's client: framed socket writes and dataSendToMe packets.
function recording(session) {
    session.sent = [];
    session.written = [];
    session.socket = { write: (buffer) => session.written.push(buffer) };
    session.dataSendToMe = (packet) => session.sent.push(packet);
    session.actor.statusUpdateVitals = () => assert.fail('a viewer is sent the packet, not asked to build it');
    return session;
}
const farPlayer = {
    accountId: 'player_far',
    fetchAccountId() { return this.accountId; },
    actor: actorAt(3600, 0)
};
const npc = {
    fetchId: () => 1900001,
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchHp: () => 812,
    fetchMaxHp: () => 1000,
    fetchMp: () => 40,
    fetchMaxMp: () => 90
};

try {
    World.user = { sessions: [], revision: 0 };
    for (const session of [source, visiblePlayer, visibleBot, boundaryPlayer, offlinePlayer, farPlayer]) World.insertUser(session);

    assert.deepStrictEqual(
        new Set(World.fetchVisibleUsers(source, source.actor)),
        new Set([visiblePlayer, visibleBot, farPlayer]),
        'the numeric visibility check must preserve the strict 6000-unit user radius'
    );
    assert.deepStrictEqual(
        World.fetchVisibleRealPlayers(source, source.actor),
        [visiblePlayer, farPlayer],
        'the real-player fast path must exclude bots, the boundary, and offline sessions'
    );

    // A bot's packet reaches every real player who sees it, the same framed bytes; bots and
    // the sender get nothing.
    for (const session of [visiblePlayer, boundaryPlayer, offlinePlayer, farPlayer]) recording(session);
    visibleBot.dataSendToMe = () => assert.fail('a bot session is not a packet recipient');
    const say = Buffer.from([0x4a, 1, 2, 3, 4, 5, 6]);
    source.dataSendToOthers(say, source.actor);
    assert.deepStrictEqual(visiblePlayer.written, [Frame.pack(say)]);
    assert.deepStrictEqual(farPlayer.written, [Frame.pack(say)]);
    assert.deepStrictEqual([boundaryPlayer, offlinePlayer].map(session => session.written.length), [0, 0],
        'the view boundary and offline players get no bot packet');
    // An NPC's vitals: one StatusUpdate, the bytes an actor's own update would build, to the
    // real players within 3500 only (farPlayer sees it at 3600 but is outside the band).
    for (const session of [visiblePlayer, farPlayer]) session.written = [];
    broadcastVitals(npc);
    assert.strictEqual(visiblePlayer.sent.length, 1, 'a real player near the NPC gets its vitals');
    assert.deepStrictEqual(visiblePlayer.sent[0], Actor.vitalsPacket(npc));
    assert.deepStrictEqual([farPlayer, boundaryPlayer, offlinePlayer].map(session => session.sent.length), [0, 0, 0],
        'players beyond 3500 and offline ones get no vitals');
    const nearPlayer = recording({
        accountId: 'player_near',
        fetchAccountId() { return this.accountId; },
        actor: actorAt(0, 3499)
    });
    World.insertUser(nearPlayer);
    try {
        broadcastVitals(npc);
        assert.deepStrictEqual(nearPlayer.sent, [visiblePlayer.sent[1]], 'every viewer gets the same packet');
        assert.deepStrictEqual(nearPlayer.sent[0], Actor.vitalsPacket(npc));
    } finally {
        World.removeUser(nearPlayer);
    }
} finally {
    for (const session of [source, visiblePlayer, visibleBot, boundaryPlayer, offlinePlayer, farPlayer]) World.removeUser(session);
    World.user = originalUser;
}

console.log('World visible-user checks passed');
