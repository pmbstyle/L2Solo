const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Database = invoke('Database');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');

const originalExecute = Database.execute;

(async () => {
    const queries = [];
    Database.execute = (...args) => {
        queries.push(args);
        const sql = String(args?.[0]?.[0] || '');
        return Promise.resolve(sql.includes('DELETE FROM bot_background_parties')
            ? { affectedRows: 3 }
            : []);
    };

    await BackgroundPartyState.init();
    const timestamp = Date.now();
    const deleted = await BackgroundPartyState.purgeHistory(7, timestamp);
    assert.strictEqual(deleted, 3, 'cleanup should report the bounded delete count');

    const deleteQuery = queries.find((entry) => String(entry?.[0]?.[0] || '').includes('DELETE FROM bot_background_parties'));
    assert(deleteQuery, 'cleanup should issue a bounded history delete');
    assert.match(deleteQuery[0][0], /status <> 'active'/);
    assert.match(deleteQuery[0][0], /ORDER BY (?:parties\.)?updatedAt ASC/);
    assert.match(deleteQuery[0][0], /NOT EXISTS/);
    assert.match(deleteQuery[0][0], /LIMIT 7/);
    assert.deepStrictEqual(deleteQuery[0][1], [timestamp - Config.partyHistoryRetentionMs]);

    console.log('Background party history cleanup checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.execute = originalExecute;
});
