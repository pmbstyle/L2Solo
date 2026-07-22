const assert = require('assert');
const { targetClause, validateScope, previewWithConnection, wipeWithConnection } = require('../scripts/world-wipe');

function fakeConnection() {
    const queries = [];
    return {
        queries,
        async query(sql, params = []) {
            queries.push({ sql, params });
            if (sql.startsWith('SELECT COUNT(*) AS count FROM characters')) return [{ count: 2 }];
            if (sql.startsWith('SELECT COUNT(*) AS count FROM accounts')) return [{ count: 3 }];
            if (sql.startsWith('SELECT id FROM characters')) return [{ id: 11 }, { id: 12 }];
            if (sql.startsWith('SELECT id FROM clans')) return [{ id: 7 }];
            return [];
        },
        async beginTransaction() { queries.push({ sql: 'BEGIN' }); },
        async commit() { queries.push({ sql: 'COMMIT' }); },
        async rollback() { queries.push({ sql: 'ROLLBACK' }); }
    };
}

(async () => {
    assert.strictEqual(validateScope('BOTS'), 'bots');
    assert.throws(() => validateScope('characters'), /bots, players, or all/);
    assert.match(targetClause('bots').sql, /LIKE/);
    assert.match(targetClause('players').sql, /NOT LIKE/);

    const previewConnection = fakeConnection();
    assert.deepStrictEqual(await previewWithConnection(previewConnection, 'players'), {
        scope: 'players', characters: 2, accounts: 3
    });

    const conn = fakeConnection();
    assert.deepStrictEqual(await wipeWithConnection(conn, 'bots'), {
        scope: 'bots', characters: 2, accounts: 3
    });
    const sql = conn.queries.map((entry) => entry.sql).join('\n');
    [
        'character_recipes', 'character_quests', 'warehouse_items', 'macros',
        'bot_goal_state', 'bot_background_parties', 'DELETE FROM accounts'
    ].forEach((table) => assert.ok(sql.includes(table), `expected cleanup for ${table}`));
    assert.ok(sql.includes('COMMIT'));

    const playerConnection = fakeConnection();
    await wipeWithConnection(playerConnection, 'players');
    const playerSql = playerConnection.queries.map((entry) => entry.sql).join('\n');
    assert.ok(!playerSql.includes('DELETE FROM bot_background_parties'));

    const allConnection = fakeConnection();
    await wipeWithConnection(allConnection, 'all');
    const allSql = allConnection.queries.map((entry) => entry.sql).join('\n');
    assert.ok(allSql.includes('DELETE FROM bot_background_parties'));
    assert.ok(allSql.includes('DELETE FROM clans'));

    console.log('world wipe scopes and cleanup ok');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
