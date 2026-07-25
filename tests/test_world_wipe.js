const assert = require('assert');
const { targetClause, validateScope, previewWithConnection, wipeWithConnection } = require('../scripts/world-wipe');

function fakeConnection() {
    const queries = [];
    const resultFor = (sql) => {
        if (sql.startsWith('SELECT COUNT(*) AS count FROM characters')) return { count: 2 };
        if (sql.startsWith('SELECT COUNT(*) AS count FROM accounts')) return { count: 3 };
        if (sql.startsWith('SELECT id FROM characters')) return [{ id: 11 }, { id: 12 }];
        if (sql.startsWith('SELECT id FROM clans WHERE leaderId IN')) return [{ id: 7 }];
        return [];
    };
    return {
        queries,
        prepare(sql) {
            return {
                get(...params) {
                    queries.push({ sql, params });
                    return resultFor(sql);
                },
                all(...params) {
                    queries.push({ sql, params });
                    return resultFor(sql);
                },
                run(...params) {
                    queries.push({ sql, params });
                    return { changes: 1 };
                }
            };
        },
        exec(sql) { queries.push({ sql, params: [] }); }
    };
}

(async () => {
    assert.strictEqual(validateScope('BOTS'), 'bots');
    assert.throws(() => validateScope('characters'), /bots, players, or all/);
    assert.match(targetClause('bots').sql, /LIKE/);
    assert.match(targetClause('players').sql, /NOT LIKE/);

    const previewConnection = fakeConnection();
    assert.deepStrictEqual(previewWithConnection(previewConnection, 'players'), {
        scope: 'players', characters: 2, accounts: 3
    });

    const conn = fakeConnection();
    assert.deepStrictEqual(wipeWithConnection(conn, 'bots'), {
        scope: 'bots', characters: 2, accounts: 3
    });
    const sql = conn.queries.map((entry) => entry.sql).join('\n');
    [
        'DELETE FROM characters', 'bot_background_parties', 'DELETE FROM accounts',
        'UPDATE characters SET clanId = 0', 'DELETE FROM clans WHERE id IN'
    ].forEach((table) => assert.ok(sql.includes(table), `expected cleanup for ${table}`));
    assert.ok(sql.includes('COMMIT'));

    const playerConnection = fakeConnection();
    wipeWithConnection(playerConnection, 'players');
    const playerSql = playerConnection.queries.map((entry) => entry.sql).join('\n');
    assert.ok(!playerSql.includes('DELETE FROM bot_background_parties'));

    const allConnection = fakeConnection();
    wipeWithConnection(allConnection, 'all');
    const allSql = allConnection.queries.map((entry) => entry.sql).join('\n');
    assert.ok(allSql.includes('DELETE FROM bot_background_parties'));
    assert.ok(allSql.includes('DELETE FROM clans'));

    console.log('world wipe scopes and cleanup ok');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
