const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

if (process.argv[2] === '--bootstrap') {
    require('../src/Global');
    const Database = invoke('Database');
    options.default.Database.path = process.argv[3];
    Database.init();
    Database.close().catch(error => { console.error(error); process.exitCode = 1; });
} else {
    const directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'test-selection-indexes-'));
    const databasePath = path.join(directory, 'states.sqlite');
    const indexNames = ['bot_goal_state_review_queue', 'bot_life_state_goal_review',
        'warehouse_items_positive_self_owner', 'bot_life_state_warehouse_release', 'bot_life_state_warehouse_demand'];
    const bootstrap = () => {
        const result = spawnSync(process.execPath, [__filename, '--bootstrap', databasePath], { encoding: 'utf8' });
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    };
    const lifeSource = fs.readFileSync('src/GameServer/Bot/Population/BotLifeState.js', 'utf8');
    const warehouseSource = fs.readFileSync('src/GameServer/Bot/Economy/BotWarehouseService.js', 'utf8');
    const extract = (source, marker) => source.slice(source.indexOf(marker)).match(/`([\s\S]*?)`/)[1];
    const goalSql = extract(lifeSource, '    staleGoalCandidates(').replaceAll('${TABLE}', 'bot_life_state');
    const warehouseSql = extract(warehouseSource, 'function releaseCandidates(');
    const enchantSql = extract(warehouseSource, 'function enchantReleaseCandidates(');
    const scrollIds = Object.entries(require('../src/GameServer/Items/C4EnchantScrolls').ENCHANT_SCROLLS)
        .filter(([, value]) => value.grade === 'D').map(([id]) => Number(id));
    let db;
    try {
        bootstrap();
        db = new DatabaseSync(databasePath);
        for (const name of indexNames) {
            assert(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('index', name),
                'fresh databases must have ' + name);
            db.exec('DROP INDEX ' + name);
        }
        db.exec('DELETE FROM schema_migrations WHERE version IN (33, 34)');
        // Query fixtures do not require a running world or player accounts.
        db.exec('PRAGMA foreign_keys = OFF; BEGIN');
        const stateInsert = db.prepare(`INSERT INTO bot_life_state
            (characterId, accountName, characterName, phase, activity, partyId, simulationOwner, updatedAt, statsJson)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const goalInsert = db.prepare('INSERT INTO bot_goal_state(characterId, goalJson, updatedAt) VALUES (?, ?, ?)');
        const itemInsert = db.prepare('INSERT INTO warehouse_items(characterId, selfId, name, amount, enchant) VALUES (?, ?, ?, ?, ?)');
        for (let id = 1; id <= 96; id++) {
            stateInsert.run(id, id % 11 === 0 ? 'BOT_CRAFT_' + id : 'bot_fixture_' + id, 'Fixture' + id,
                id % 7 === 0 ? 'hot' : id % 13 === 0 ? 'warm' : 'cold',
                ['hunting', 'resting', 'traveling', 'shopping', 'merchant', 'crafting', 'dead', 'pk_hunting'][id % 8],
                id % 9 === 0 ? 'party1' : id % 2 ? null : '',
                id % 6 === 0 ? 'cold_simulation_owner' : 'legacy_main',
                1000 + id, JSON.stringify({ equipmentPlan: { target: { selfId: 94 } }, payload: 'x'.repeat(2048) }));
            const deadline = [undefined, null, 0, 100, '200', 10000][id % 6];
            goalInsert.run(id, JSON.stringify({ type: 'hunt', nextReviewAt: deadline }), Math.floor(id / 4));
            itemInsert.run(id, scrollIds[0], 'Scroll', id % 5 === 0 ? 0 : 1, 0);
            itemInsert.run(id, 1864, 'Stem', 3, 0);
            itemInsert.run(id, 1864, 'Stem', 4, 3);
        }
        db.exec('COMMIT');
        const snapshot = () => ['bot_life_state', 'bot_goal_state', 'warehouse_items']
            .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
        const before = snapshot();
        db.close();
        db = null;
        bootstrap();
        db = new DatabaseSync(databasePath);
        assert.deepStrictEqual(snapshot(), before, 'index migration must preserve all state, JSON, item counts and enchant values');
        assert.strictEqual(db.prepare('SELECT count(*) n FROM schema_migrations WHERE version = 33').get().n, 1);
        assert.strictEqual(db.prepare('SELECT count(*) n FROM schema_migrations WHERE version = 34').get().n, 1);

        function verify() {
            const states = db.prepare('SELECT * FROM bot_life_state').all();
            const goals = new Map(db.prepare('SELECT * FROM bot_goal_state').all().map(row => [row.characterId, row]));
            for (const timestamp of [-1, 0, 250, 20000]) for (const limit of [1, 8, 50]) {
                const expected = states.filter(state => {
                    const goal = goals.get(state.characterId);
                    return state.phase === 'cold' && !state.partyId
                        && !['traveling', 'shopping', 'merchant', 'crafting'].includes(state.activity)
                        && goal && Math.trunc(Number(JSON.parse(goal.goalJson)?.nextReviewAt || 0)) <= timestamp;
                }).sort((a, b) => goals.get(a.characterId).updatedAt - goals.get(b.characterId).updatedAt
                    || a.updatedAt - b.updatedAt).slice(0, limit).map(state => state.characterId);
                const actual = db.prepare(goalSql.replaceAll('${safeLimit}', String(limit))).all(timestamp);
                assert.deepStrictEqual(actual.map(row => row.characterId), expected, 'goal due, eligibility, order and limit parity');
                for (const row of actual) assert.strictEqual(row.currentGoalJson, goals.get(row.characterId).goalJson);
            }
            const items = db.prepare('SELECT * FROM warehouse_items').all();
            const eligible = states.filter(state => state.phase === 'cold' && state.simulationOwner === 'legacy_main'
                && !/^bot.craft..*$/i.test(state.accountName) && !state.partyId && ['hunting', 'resting'].includes(state.activity));
            for (const demand of [[1864], [scrollIds[0]], [1864, scrollIds[0]], [999999]]) for (const limit of [1, 8, 50]) {
                const expected = eligible.filter(state => items.some(item => item.characterId === state.characterId
                    && item.amount > 0 && demand.includes(item.selfId))).sort((a, b) => a.updatedAt - b.updatedAt
                        || a.characterId - b.characterId)
                    .slice(0, limit).map(state => state.characterId);
                const sql = warehouseSql.replaceAll("${demandIds.map(() => '?').join(', ')}", demand.map(() => '?').join(','))
                    .replaceAll('${safeLimit}', String(limit));
                assert.deepStrictEqual(db.prepare(sql).all(...demand).map(row => row.characterId), expected,
                    'warehouse demand, ownership, service, party, duplicate and quantity parity');
            }
            for (const cursor of [0, 24, 90, 999]) {
                const expected = eligible.filter(state => state.characterId > cursor && items.some(item =>
                    item.characterId === state.characterId && item.amount > 0 && scrollIds.includes(item.selfId)))
                    .sort((a, b) => a.characterId - b.characterId).slice(0, 8).map(state => state.characterId);
                const sql = enchantSql.replaceAll("${scrollIds.map(() => '?').join(', ')}", scrollIds.map(() => '?').join(','))
                    .replaceAll('${safeLimit}', '8');
                assert.deepStrictEqual(db.prepare(sql).all(...scrollIds, cursor).map(row => row.characterId), expected,
                    'enchant cursor and positive quantity parity');
            }
        }
        verify();
        db.exec(`UPDATE bot_life_state SET phase = 'hot' WHERE characterId = 1;
            UPDATE bot_life_state SET phase = 'cold', activity = 'hunting' WHERE characterId = 7;
            UPDATE bot_life_state SET partyId = 'new_party' WHERE characterId = 8;
            UPDATE bot_life_state SET partyId = NULL, simulationOwner = 'legacy_main', activity = 'resting' WHERE characterId = 18;
            UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner' WHERE characterId = 16;
            UPDATE bot_life_state SET accountName = 'bot_craft_changed' WHERE characterId = 17;
            UPDATE warehouse_items SET amount = 0 WHERE characterId = 24;
            UPDATE warehouse_items SET amount = 4 WHERE characterId = 25;
            UPDATE bot_life_state SET updatedAt = 1000 WHERE characterId IN (25, 32, 40, 41, 49);
            UPDATE bot_goal_state SET goalJson = '{"nextReviewAt":99999}', updatedAt = 100 WHERE characterId = 9;
            UPDATE bot_goal_state SET goalJson = '{"type":"hunt"}', updatedAt = 1 WHERE characterId = 8;`);
        verify();
        const changed = snapshot();
        db.exec(`BEGIN; UPDATE bot_life_state SET phase = 'hot'; UPDATE warehouse_items SET amount = 0;
            UPDATE bot_goal_state SET goalJson = '{}'; ROLLBACK;`);
        assert.deepStrictEqual(snapshot(), changed);
        verify();
        const goalPlan = db.prepare('EXPLAIN QUERY PLAN ' + goalSql.replaceAll('${safeLimit}', '8')).all(250);
        assert(goalPlan.some(row => row.detail.includes('bot_goal_state_review_queue')));
        assert(goalPlan.some(row => row.detail.includes('bot_life_state_goal_review')));
        const marketPlan = db.prepare('EXPLAIN QUERY PLAN ' + warehouseSql
            .replaceAll("${demandIds.map(() => '?').join(', ')}", '?').replaceAll('${safeLimit}', '8')).all(1864);
        assert(marketPlan.some(row => row.detail.includes('bot_life_state_warehouse_demand')),
            'common and rare demand must traverse only eligible owners in oldest-state order');
        assert(!marketPlan.some(row => /TEMP B-TREE FOR ORDER BY/.test(row.detail)),
            'the market lookup must not sort all matching warehouse owners');
        const enchantPlan = db.prepare('EXPLAIN QUERY PLAN ' + enchantSql
            .replaceAll("${scrollIds.map(() => '?').join(', ')}", scrollIds.map(() => '?').join(','))
            .replaceAll('${safeLimit}', '8')).all(...scrollIds, 0);
        assert(enchantPlan.some(row => row.detail.includes('warehouse_items_positive_self_owner')));
        assert(enchantPlan.some(row => row.detail.includes('bot_life_state_warehouse_release')));
        db.close();
        db = null;
        bootstrap();
        db = new DatabaseSync(databasePath);
        assert.deepStrictEqual(snapshot(), changed, 'repeated startup must preserve state');
        assert.strictEqual(db.prepare('SELECT count(*) n FROM schema_migrations WHERE version = 33').get().n, 1);
        assert.strictEqual(db.prepare('SELECT count(*) n FROM schema_migrations WHERE version = 34').get().n, 1);
        verify();
        console.log('Selection index migration, query parity, lifecycle transitions, and rollback checks passed');
    } finally {
        db?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
