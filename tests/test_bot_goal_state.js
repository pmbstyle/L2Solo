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
        plan: { kind: 'farm_route', routeId: 'death_pass_dv_40_52', economyInputKey: 'legacy-bag-cache', inputKey: 'legacy-input' },
        blockers: ['spot_contested', 'spot_contested', '']
    }, { inputHash: 0x1234abcd }).then((snapshot) => {
        assert(snapshot, 'valid goals should persist');
        assert.strictEqual(snapshot.inputHash, 0x1234abcd);
        assert.strictEqual(snapshot.current.plan.economyInputKey, undefined);
        assert.strictEqual(snapshot.current.plan.inputKey, undefined);
        assert.strictEqual(snapshot.current.priority, 100);
        assert.deepStrictEqual(snapshot.current.blockers, ['spot_contested']);
        assert.strictEqual(GoalState.snapshot(77).current.type, 'upgrade_gear');
        assert(statements.some((entry) => entry.sql === 'SELECT 1'), 'schema is owned by the SQLite migration, not hot-path DDL');
        const insert = statements.find((entry) => entry.sql.includes('INSERT INTO bot_goal_state'));
        assert(insert, 'goal state should use one upsert boundary');
        assert.strictEqual(insert.params[0], 77);
        const stored = JSON.parse(insert.params[1]);
        assert.strictEqual(stored.inputHash, undefined);
        assert.strictEqual(stored.plan.economyInputKey, undefined);
        assert.strictEqual(GoalState.prime(78, insert.params[1]).inputHash, undefined, 'restart replans once');
        const Service = invoke('GameServer/Bot/Goals/GoalService');
        const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
        const Chat = invoke('GameServer/Bot/AI/BotClanChat');
        const originalNeeds = Needs.evaluate, originalChat = Chat.onGoal;
        Needs.evaluate = state => [{ type: 'progress_level', status: 'active', priority: 50,
            inputHash: require('../src/GameServer/Bot/Fnv1a').fnv1a32(String(state.adena)),
            target: { level: 31 }, plan: { kind: 'hunt' } }];
        Chat.onGoal = () => {};
        const state = { characterId: 81, phase: 'cold', adena: 1000 };
        const count = () => statements.filter(row => row.sql.includes('INSERT INTO bot_goal_state')).length;
        const before = count();
        return Service.review(state, { now: 100000 }).then(first =>
            Service.review(state, { now: 100001 }).then(same => {
                assert.strictEqual(same.current, first.current, 'same hash retains the in-memory goal');
                assert.strictEqual(count(), before + 1, 'unchanged review makes no write');
                return Service.review({ ...state, adena: 2000 }, { now: 100002 });
            })).then(() => {
                assert.strictEqual(count(), before + 2, 'wallet change replans');
            }).finally(() => { Needs.evaluate = originalNeeds; Chat.onGoal = originalChat; })
            .then(() => GoalState.set(0, { type: 'earn_adena' })).then((invalid) => {
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
