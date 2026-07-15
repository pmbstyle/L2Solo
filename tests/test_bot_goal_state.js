const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');

const originalExecute = Database.execute;
const statements = [];

try {
    Database.execute = ([sql, params]) => {
        statements.push({ sql: String(sql), params });
        return Promise.resolve([]);
    };

    GoalState.reset();
    GoalState.set(77, {
        type: 'upgrade_gear',
        status: 'active',
        priority: 120,
        target: { equipmentSlot: 'weapon' },
        plan: { kind: 'farm_route', routeId: 'death_pass_dv_40_52' },
        blockers: ['spot_contested', 'spot_contested', '']
    }).then((snapshot) => {
        assert(snapshot, 'valid goals should persist');
        assert.strictEqual(snapshot.current.priority, 100);
        assert.deepStrictEqual(snapshot.current.blockers, ['spot_contested']);
        assert.strictEqual(GoalState.snapshot(77).current.type, 'upgrade_gear');
        assert(statements.some((entry) => entry.sql.includes('CREATE TABLE IF NOT EXISTS bot_goal_state')));
        const insert = statements.find((entry) => entry.sql.includes('INSERT INTO bot_goal_state'));
        assert(insert, 'goal state should use one upsert boundary');
        assert.strictEqual(insert.params[0], 77);
        return GoalState.set(0, { type: 'earn_adena' }).then((invalid) => {
            assert.strictEqual(invalid, null, 'goals require a persisted character id');
            console.log('Bot goal state checks passed');
        });
    }).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    }).finally(() => {
        Database.execute = originalExecute;
        GoalState.reset();
    });
} catch (err) {
    Database.execute = originalExecute;
    GoalState.reset();
    throw err;
}
