const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clan-read-indexes-'));
options.default.Database.path = path.join(directory, 'world.sqlite');
const query = (sql, args = []) => Database.execute([sql, args]);

(async () => {
    Database.init();
    try {
        // The ledger is world state; goal events are in the history file.
        const checks = [
            [query, 'SELECT MAX(warehouseRevision) AS v FROM clan_warehouse_ledger WHERE clanId = ?',
                'COVERING INDEX clan_warehouse_ledger_revision'],
            [(sql, args) => Database.readHistory([sql, args]),
                `SELECT id, clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt
                FROM clan_goal_events WHERE clanId = ? AND eventType != 'action_succeeded'
                ORDER BY occurredAt DESC, id DESC LIMIT 120`,
            'INDEX clan_goal_events_meaningful_recent']
        ];
        const verify = async () => {
            for (const [read, sql, index] of checks) {
                const plan = await read(`EXPLAIN QUERY PLAN ${sql}`, [7]);
                assert(plan.some(row => row.detail.includes(index)), JSON.stringify(plan));
                assert(!plan.some(row => row.detail.includes('TEMP B-TREE')), 'history ordering must use its index');
            }
        };
        await verify();
        // Exercise upgrading an existing database, not just creating a fresh one.
        await query('DROP INDEX clan_warehouse_ledger_revision');
        await query('DELETE FROM schema_migrations WHERE version = 49');
        const historyPath = Database.stats().historyPath;
        await Database.close();
        const history = new DatabaseSync(historyPath);
        history.exec('DROP INDEX clan_goal_events_meaningful_recent');
        history.close();
        Database.init();
        await verify();
        await Database.close();
        Database.init();
        await verify();
        console.log('Clan read indexes: fresh database, migration and reopen passed');
    } finally {
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
