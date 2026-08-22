const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotSession = invoke('GameServer/Bot/BotSession');

function actorAt(x, y, online = true) {
    return {
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchIsOnline: () => online
    };
}

const originalUser = World.user;
const source = new BotSession('bot_source');
source.actor = actorAt(0, 0);
const visiblePlayer = {
    accountId: 'player_visible',
    actor: actorAt(100, 100)
};
const visibleBot = new BotSession('bot_visible');
visibleBot.actor = actorAt(-100, -100);
const boundaryPlayer = {
    accountId: 'player_boundary',
    actor: actorAt(6000, 0)
};
const offlinePlayer = {
    accountId: 'player_offline',
    actor: actorAt(100, 100, false)
};

try {
    World.user = { sessions: [source, visiblePlayer, visibleBot, boundaryPlayer, offlinePlayer] };

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
    World.user = originalUser;
}

console.log('World visible-user checks passed');
