const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotSession = invoke('GameServer/Bot/BotSession');

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

try {
    World.user = { sessions: [], revision: 0 };
    for (const session of [source, visiblePlayer, visibleBot, boundaryPlayer, offlinePlayer]) World.insertUser(session);

    assert.deepStrictEqual(
        World.fetchVisibleUsers(source, source.actor),
        [visiblePlayer, visibleBot],
        'the numeric visibility check must preserve the strict 6000-unit user radius'
    );
    assert.deepStrictEqual(
        World.fetchVisibleRealPlayers(source, source.actor),
        [visiblePlayer],
        'the real-player fast path must exclude bots, the boundary, and offline sessions'
    );
} finally {
    for (const session of [source, visiblePlayer, visibleBot, boundaryPlayer, offlinePlayer]) World.removeUser(session);
    World.user = originalUser;
}

console.log('World visible-user checks passed');
