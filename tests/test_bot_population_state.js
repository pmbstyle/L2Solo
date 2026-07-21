const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');

DataCache.init();

const originalExecute = Database.execute;
const statements = [];

try {
    Database.execute = ([sql, params]) => {
        statements.push({ sql: String(sql), params });
        if (String(sql).startsWith('SELECT id, classId, level, exp, sp FROM characters')) {
            return Promise.resolve([{ id: 42, classId: 31, level: 42, exp: 0, sp: 0 }]);
        }
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
        assert(!recovery.sql.includes('activity <> \'crafting\''), 'craft services must recover as cold because they have no static startup owner');
        assert(recovery.sql.includes("WHEN activity IN ('following', 'shopping', 'getting_buffed', 'fleeing', 'pk_fleeing') THEN 'hunting'"));
        assert.strictEqual(recovery.params.length, 2, 'recovery query should set next resolve and updated timestamps');
        const craftRecovery = statements.find((entry) => entry.sql.includes("startup_craft_wait_recovery"));
        assert(craftRecovery, 'bot life init must release stale craft waits after a restart');
        assert(craftRecovery.sql.includes("AND activity = 'crafting'"), 'only stale station waits should be recovered as hunters');
        assert.strictEqual(craftRecovery.params[1], craftRecovery.params[0], 'recovered craft waits must be due immediately for their replan');
        return BotLifeState.upsertState({
            characterId: 42, name: 'PersistenceProbe', level: 42, phase: 'cold', activity: 'hunting',
            timing: { activityStartedAt: 1, nextResolveAt: 2, lastResolvedAt: 1 },
            vitals: {}, stats: { classId: 31 }, inventory: {}
        }, 'persistence_probe').then(() => {
            const save = statements.find((entry) => entry.sql.includes('ON DUPLICATE KEY UPDATE'));
            assert(save.sql.includes('nextResolveAt = VALUES(nextResolveAt)'), 'persisted cold resolve timing must advance after every tick');
            assert(save.sql.includes('lastResolvedAt = VALUES(lastResolvedAt)'), 'persisted cold resolve history must survive an upsert');
            assert(save.sql.includes('inventorySummary = VALUES(inventorySummary)'), 'background drop rewards must persist after an upsert');
            return BotLifeState.migrateLegacyClassProgression(1).then((migrated) => {
                assert.strictEqual(migrated.length, 1, 'legacy cold bots without progression markers must be migrated');
                const classUpdate = statements.filter((entry) => entry.sql.includes('classId')).at(-1);
                assert(classUpdate, 'migration must persist the profession on the physical character');
                assert.ok([36, 37].includes(classUpdate.params[0]), 'migration must use the physical character class as its source of truth');
                return BotLifeState.dueCold(5, 1000);
            });
        }).then(() => {
            const due = statements.find((entry) => entry.sql.includes("WHEN activity IN ('traveling', 'crafting') THEN 0"));
            assert(due.sql.includes('rateModelVersion'), 'due cold states must prioritize persisted plans from an older drop-rate model');
            assert(due.sql.includes("WHEN activity IN ('traveling', 'crafting') THEN 0"), 'due cold states must promptly finish travel and crafting transitions');
            assert(due.sql.includes("startup_craft_wait_recovery"), 'startup craft recovery must immediately replan before the ordinary hunting backlog');
            assert(due.sql.includes('COALESCE(nextResolveAt, 0) ASC'), 'due cold states must remain fair by schedule within each lifecycle bucket');
            console.log('Bot population state checks passed');
        });
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
