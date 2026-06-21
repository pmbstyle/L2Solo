const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');

function actor(online = true) {
    return {
        fetchIsOnline: () => online
    };
}

const botSession = {
    accountId: 'bot_test',
    actor: actor(true)
};
const visiblePlayer = {
    accountId: 'player_test',
    actor: actor(true)
};
const visibleBot = {
    accountId: 'bot_other',
    actor: actor(true)
};
const offlinePlayer = {
    accountId: 'player_offline',
    actor: actor(false)
};

const World = {
    fetchVisibleUsers() {
        return [visiblePlayer, visibleBot, offlinePlayer];
    }
};

assert.deepStrictEqual(BotAI.visibleRealPlayers(botSession, botSession.actor, World), [visiblePlayer]);
assert.deepStrictEqual(BotAI.visibleRealPlayers(botSession, botSession.actor, { fetchVisibleUsers: () => [] }), []);

console.log('Bot AI visibility checks passed');
