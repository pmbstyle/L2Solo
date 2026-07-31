const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const BotFriendship = invoke('GameServer/Bot/AI/BotFriendship');
const originalExecute = Database.execute;
let rosterCount = 7;

Database.execute = ([sql]) => {
    const text = String(sql);
    if (text.includes('FROM bot_friendships')) return Promise.resolve([{}]);
    if (text.includes('FROM bot_friend_roster WHERE playerId') && text.includes('botId')) return Promise.resolve([]);
    if (text.includes('COUNT(*) AS count')) return Promise.resolve([{ count: rosterCount }]);
    if (text.includes('INSERT INTO bot_friend_roster')) {
        rosterCount += 1;
        return Promise.resolve([]);
    }
    throw new Error(`Unexpected SQL: ${text}`);
};

Promise.all([
    BotFriendship.toggleConst({ characterId: 42 }, 100),
    BotFriendship.toggleConst({ characterId: 42 }, 101)
]).then(([first, second]) => {
    assert.strictEqual(first.selected, true);
    assert.strictEqual(second.reason, 'const_full', 'concurrent selections must not exceed eight const members');
    assert.strictEqual(rosterCount, 8);
    console.log('Bot friendship roster checks passed');
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.execute = originalExecute;
});
