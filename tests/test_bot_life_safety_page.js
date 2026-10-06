'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../src/Global');

const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
// Only the native DB and a cold lifecycle module: no server, cache bootstrap,
// live characters, population workers or pending market-learning policy.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-safety-page-'));
const previous = { path: options.default.Database.path, historyPath: options.default.Database.historyPath };
const fields = ['characterId', 'phase', 'activity', 'simulationOwner', 'simulationRevision',
    'simulationLeaseId', 'simulationLeaseUntil', 'activityStartedAt', 'nextResolveAt',
    'lastResolvedAt', 'lastHotAt', 'updatedAt'];
const range = `SELECT ${fields.join(', ')} FROM bot_life_state
    WHERE characterId > ? AND characterId <= ? ORDER BY characterId ASC LIMIT ?`;
const activities = ['hunting', 'resting', 'shopping', 'dead', 'quest', 'crafting', 'fixture_activity'];
const revision = LifeState.stateRevision();
const execute = Database.execute;
const sqlReads = [];
let opened = false;

async function seedLifecycle() {
    await execute.call(Database, [`INSERT INTO bot_life_state
        (characterId, phase, activity, simulationOwner, simulationRevision, simulationLeaseId,
         simulationLeaseUntil, activityStartedAt, nextResolveAt, lastResolvedAt, lastHotAt,
         updatedAt, statsJson, inventorySummary)
        SELECT id, CASE WHEN id % 2 = 0 THEN 'hot' ELSE 'cold' END,
        CASE id % 7 WHEN 0 THEN 'hunting' WHEN 1 THEN 'resting' WHEN 2 THEN 'shopping'
        WHEN 3 THEN 'dead' WHEN 4 THEN 'quest' WHEN 5 THEN 'crafting' ELSE 'fixture_activity' END,
        CASE WHEN id % 3 = 0 THEN 'fixture_worker' ELSE 'legacy_main' END, id,
        CASE WHEN id % 3 = 0 THEN 'lease-' || id ELSE NULL END,
        id * 1000, id * 10, id * 100, id * 20, id * 30, id * 40, ?, ?
        FROM characters WHERE id <= 70`,
    [JSON.stringify({ fixture: 'x'.repeat(20000), equipmentPlan: { status: 'active', next: { spotId: 'fixture' } } }),
        JSON.stringify({ 1864: { amount: 123 } })]], 'fixture:safety-seed');
}

function assertCacheEmpty() {
    assert.equal(LifeState.stateRevision(), revision, 'native page must not hydrate/change lifecycle cache');
    for (const id of [1, 64, 70, 71]) assert.equal(LifeState.snapshot(id), null, 'no implicit normalize/cache bootstrap');
}

async function controls() {
    assert.equal(Database.isReady(), true);
    assert.deepEqual(await execute.call(Database, ['SELECT COALESCE(MAX(characterId), 0) AS highWaterId FROM bot_life_state', []]),
        [{ highWaterId: 0 }], 'empty native table has zero highWater');
    const schema = await execute.call(Database, ['PRAGMA table_info(bot_life_state)', []]);
    const pk = schema.find(row => row.name === 'characterId');
    assert(pk && pk.type === 'INTEGER' && pk.pk === 1, 'actual schema has stable INTEGER PRIMARY KEY');
    await Database.createAccount('bot_safety_fixture', 'pw');
    await execute.call(Database, [`WITH RECURSIVE ids(id) AS
        (SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 71)
        INSERT INTO characters (id, username, name, classId, race, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ)
        SELECT id, 'bot_safety_fixture', 'SafetyFixture' || id, 0, 0, 100, 100,
        0, 0, 0, 0, 0, 0, 0 FROM ids`, []], 'fixture:safety-characters');
    await seedLifecycle();
    const bounds = (await execute.call(Database, ['SELECT COUNT(*) AS count, MAX(characterId) AS highWaterId FROM bot_life_state', []]))[0];
    assert.deepEqual(bounds, { count: 70, highWaterId: 70 });
    const plan = await execute.call(Database, [`EXPLAIN QUERY PLAN ${range}`, [0, 70, 64]]);
    assert(plan.some(row => /SEARCH bot_life_state USING INTEGER PRIMARY KEY/.test(row.detail)), JSON.stringify(plan));
    assert(plan.every(row => !/SCAN bot_life_state|TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
    const first = await execute.call(Database, [range, [0, bounds.highWaterId, 64]]);
    assert.deepEqual(first.map(row => row.characterId), Array.from({ length: 64 }, (_, i) => i + 1));
    assert.deepEqual(new Set(first.map(row => row.activity)), new Set(activities), 'no activity exclusions');
    assert.deepEqual(new Set(first.map(row => row.phase)), new Set(['hot', 'cold']));
    assert(first.every(row => Object.keys(row).join(',') === fields.join(',')), 'only compact scalar columns');
    assert.deepEqual(first[0], { characterId: 1, phase: 'cold', activity: 'resting',
        simulationOwner: 'legacy_main', simulationRevision: 1, simulationLeaseId: null,
        simulationLeaseUntil: 1000, activityStartedAt: 10, nextResolveAt: 100,
        lastResolvedAt: 20, lastHotAt: 30, updatedAt: 40 }, 'native scalar payload positive control');
    await execute.call(Database, ['DELETE FROM bot_life_state WHERE characterId IN (65, 70)', []]);
    await execute.call(Database, ['UPDATE bot_life_state SET updatedAt = 9000000 - characterId', []]);
    await execute.call(Database, ["INSERT INTO bot_life_state(characterId, activity) VALUES (71, 'new_cycle')", []]);
    const last = await execute.call(Database, [range, [64, bounds.highWaterId, 64]]);
    assert.deepEqual(last.map(row => row.characterId), [66, 67, 68, 69], 'deletes/churn cannot change PK cursor; new71 excluded');
    assert.deepEqual(await execute.call(Database, [range, [70, 70, 64]]), [], 'final native range is empty');
    assertCacheEmpty();
    assert(!Object.keys(require.cache).some(key => key.endsWith('/PriceLearning.js')),
        'safety paging must not depend on the unfinished learning helper');
    console.log(`PASS native controls: 70 uncached lifecycle rows, PK plan ${plan[0].detail}, compact64+4, deletes/churn/new71 excluded`);
    await execute.call(Database, ['DELETE FROM bot_life_state', []]);
    await seedLifecycle();
}

async function contracts() {
    assert.equal(typeof LifeState.safetyPage, 'function', 'missing generic bounded LifeState.safetyPage API');
    Database.execute = async function(statement, operation) {
        const result = await execute.call(this, statement, operation);
        sqlReads.push({ sql: statement[0], params: statement[1] || [], count: Array.isArray(result) ? result.length : 0 });
        return result;
    };
    const first = await LifeState.safetyPage({ limit: 64 });
    assert.deepEqual(first.cursor, { afterId: 64, highWaterId: 70 });
    assert.equal(first.done, false);
    assert.deepEqual(first.rows.map(row => row.characterId), Array.from({ length: 64 }, (_, i) => i + 1));
    assert(first.rows.every(row => Object.keys(row).join(',') === fields.join(',')));
    assert.deepEqual(first.rows[0], { characterId: 1, phase: 'cold', activity: 'resting',
        simulationOwner: 'legacy_main', simulationRevision: 1, simulationLeaseId: null,
        simulationLeaseUntil: 1000, activityStartedAt: 10, nextResolveAt: 100,
        lastResolvedAt: 20, lastHotAt: 30, updatedAt: 40 }, 'no normalization of authority/timing');
    const compact = sqlReads.find(entry => /WHERE\s+characterId\s*>/i.test(entry.sql));
    assert(compact && compact.count === 64 && compact.params[2] === 64, 'actual LIMIT is64, never65');
    assert(!/SELECT\s+\*|json_|\bOFFSET\b/i.test(compact.sql), 'no full rows, JSON or OFFSET');
    assert.equal(sqlReads.filter(entry => /\bMAX\s*\(/i.test(entry.sql)).length, 1);
    assertCacheEmpty();
    await execute.call(Database, ['DELETE FROM bot_life_state WHERE characterId IN (65,70)', []]);
    await execute.call(Database, ['UPDATE bot_life_state SET updatedAt = 9000000 - characterId', []]);
    await execute.call(Database, ["INSERT INTO bot_life_state(characterId, activity) VALUES (71, 'new_cycle')", []]);
    const second = await LifeState.safetyPage({ ...first.cursor, limit: 64 });
    assert.deepEqual(second.rows.map(row => row.characterId), [66, 67, 68, 69]);
    assert.deepEqual(second.cursor, { afterId: 70, highWaterId: 70 });
    assert.equal(second.done, true);
    const readsBeforeFinal = sqlReads.length;
    assert.deepEqual(await LifeState.safetyPage({ ...second.cursor }), { rows: [], cursor: second.cursor, done: true });
    assert.equal(sqlReads.length, readsBeforeFinal, 'repeat final is O1 no row query');
    assert.equal(sqlReads.filter(entry => /\bMAX\s*\(/i.test(entry.sql)).length, 1, 'fixed highWater throughout cycle');
    const fresh = await LifeState.safetyPage({ limit: 64 });
    assert.equal(fresh.cursor.highWaterId, 71, 'new cycle captures appended71');
    const tail = await LifeState.safetyPage({ ...fresh.cursor, limit: 64 });
    assert(tail.rows.some(row => row.characterId === 71));
    const invalid = [null, [], { afterId: -1 }, { afterId: 1 }, { afterId: '0' }, { highWaterId: '70' },
        { highWaterId: null }, { afterId: NaN }, { highWaterId: Infinity }, { limit: 0 }, { limit: 65 },
        { limit: 1.5 }, { limit: '64' }, { limit: true }, { afterId: 71, highWaterId: 70 },
        { highWaterId: Number.MAX_SAFE_INTEGER + 1 }];
    const readsBeforeInvalid = sqlReads.length;
    for (const args of invalid) await assert.rejects(() => LifeState.safetyPage(args),
        error => error instanceof TypeError || error instanceof RangeError);
    assert.equal(sqlReads.length, readsBeforeInvalid, 'strict validation precedes SQL');
    const failure = await execute.call(Database, ['SELECT missing_safety_column FROM bot_life_state', []])
        .then(() => { throw new Error('invalid native statement unexpectedly succeeded'); }, error => error);
    assert.equal(failure.code, 'ERR_SQLITE_ERROR', 'fault injection preserves an actual native SQL error');
    Database.execute = () => Promise.reject(failure);
    await assert.rejects(() => LifeState.safetyPage({ ...first.cursor }), error => error === failure);
    assert.deepEqual(first.cursor, { afterId: 64, highWaterId: 70 }, 'error leaves reusable cursor unchanged');
    Database.execute = execute;
    await execute.call(Database, ['DELETE FROM bot_life_state', []]);
    await seedLifecycle();
    await execute.call(Database, ['DELETE FROM bot_life_state WHERE characterId > 64', []]);
    const exact = await LifeState.safetyPage({ afterId: 0, highWaterId: 70, limit: 64 });
    assert.equal(exact.rows.length, 64);
    assert.equal(exact.done, false, 'exact-size page must not inspect deleted tail beyond the budget');
    const emptyTail = await LifeState.safetyPage({ ...exact.cursor, limit: 64 });
    assert.deepEqual(emptyTail, { rows: [], cursor: { afterId: 70, highWaterId: 70 }, done: true });
    const one = await LifeState.safetyPage({ afterId: 0, highWaterId: 64, limit: 1 });
    assert.deepEqual(one.cursor, { afterId: 1, highWaterId: 64 });
    assert.equal(one.rows.length, 1, 'caller can select a smaller inspection budget');
    const exactEnd = await LifeState.safetyPage({ afterId: 63, highWaterId: 64, limit: 1 });
    assert.deepEqual(exactEnd.cursor, { afterId: 64, highWaterId: 64 });
    assert.equal(exactEnd.done, true, 'last existing highWater finishes an exact-size page');
    await execute.call(Database, ['DELETE FROM bot_life_state', []]);
    assert.deepEqual(await LifeState.safetyPage(), { rows: [], cursor: { afterId: 0, highWaterId: 0 }, done: true });
    assertCacheEmpty();
    // SQLite permits a manually assigned negative INTEGER PRIMARY KEY. The
    // first cursor must still satisfy the continuation's strict ID domain.
    await execute.call(Database, [`INSERT INTO characters
        (id, username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
        VALUES (-1, 'bot_safety_fixture', 'SafetyNegativeIdentity', 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`, []]);
    await execute.call(Database, ['INSERT INTO bot_life_state(characterId) VALUES (-1)', []]);
    assert.deepEqual(await execute.call(Database, ['SELECT MAX(characterId) AS highWaterId FROM bot_life_state', []]),
        [{ highWaterId: -1 }], 'actual malformed stored identity positive control');
    await assert.rejects(() => LifeState.safetyPage(), error => error instanceof RangeError,
        'captured high-water must not emit an invalid reusable cursor');
    await Database.close();
    opened = false;
    await assert.rejects(() => LifeState.safetyPage({ afterId: 0, highWaterId: 0 }),
        error => error.code === 'BOT_LIFE_SAFETY_UNAVAILABLE', 'unready is not an empty successful cycle');
    console.log('Bot lifecycle safety-page native tests passed');
}

(async () => {
    try {
        assert.equal(Database.isReady(), false, 'fixture begins without a connection');
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        await new Promise(resolve => Database.init(resolve));
        opened = true;
        await controls();
        await contracts();
    } finally {
        Database.execute = execute;
        if (opened) await Database.close();
        options.default.Database.path = previous.path;
        options.default.Database.historyPath = previous.historyPath;
        fs.rmSync(directory, { recursive: true, force: true });
        console.log('Disposable SQLite fixture closed and removed');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
