const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');

const originalExecute = Database.execute;
const statements = [];

try {
    Database.execute = ([sql, params]) => {
        statements.push({ sql: String(sql), params });
        if (String(sql).startsWith('UPDATE bot_life_state')) {
            return Promise.resolve({ affectedRows: 2 });
        }
        if (String(sql).startsWith('SELECT * FROM bot_life_state')) {
            return Promise.resolve([]);
        }
        return Promise.resolve([]);
    };

    const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');

    BotLifeState.init().then((ready) => {
        assert.strictEqual(ready, true);
        const recovery = statements.find((entry) => entry.sql.includes("WHERE phase = 'hot'"));
        assert(recovery, 'bot life init should recover stale hot records on startup');
        assert(recovery.sql.includes("activity <> 'merchant' OR statsJson LIKE '%\"marketStore\"%'"), 'only dynamic market merchants should be recovered; configured static merchants remain hot');
        assert(recovery.sql.includes("WHEN activity IN ('following', 'shopping', 'getting_buffed', 'fleeing', 'pk_fleeing') THEN 'hunting'"));
        assert.strictEqual(recovery.params.length, 2, 'recovery query should set next resolve and updated timestamps');
        console.log('Bot population state checks passed');
    }).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    }).finally(() => {
        Database.execute = originalExecute;
    });
} catch (err) {
    Database.execute = originalExecute;
    throw err;
}
