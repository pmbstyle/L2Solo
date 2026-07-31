const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const BotFriendship = invoke('GameServer/Bot/AI/BotFriendship');
const originalExecute = Database.execute;
let rosterCount = 7;
let requestSocial = {
    trust: 20,
    insults: 0,
    recentlyAbandonedAt: Date.now() - 10 * 60 * 1000
};

Database.execute = ([sql]) => {
    const text = String(sql);
    if (text.includes('FROM bot_social_memory')) return Promise.resolve([requestSocial]);
    if (text.includes('INSERT INTO bot_friendships')) return Promise.resolve([]);
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
]).then(async ([first, second]) => {
    assert.strictEqual(first.selected, true);
    assert.strictEqual(second.reason, 'const_full', 'concurrent selections must not exceed eight const members');
    assert.strictEqual(rosterCount, 8);
    const accepted = await BotFriendship.request({ characterId: 42 }, { characterId: 100, name: 'OldFriend' });
    assert.strictEqual(accepted.ok, true, 'an old abandonment cooldown must not block friendship forever');
    requestSocial = { trust: 20, insults: 0, recentlyAbandonedAt: Date.now() - 1000 };
    const coolingDown = await BotFriendship.request({ characterId: 42 }, { characterId: 101, name: 'CoolingFriend' });
    assert.strictEqual(coolingDown.reason, 'recently_abandoned', 'a recent abandonment must still be respected');
    const removed = await BotFriendship.remove({ characterId: 42 }, 100);
    assert.strictEqual(removed.ok, true, 'removing a friend should clear friendship and const membership');
    console.log('Bot friendship roster checks passed');
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.execute = originalExecute;
});
