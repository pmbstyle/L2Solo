const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const Retention = invoke('GameServer/Bot/Population/PersistentStateRetention');
const databasePath = path.join(process.cwd(), 'tmp', 'test-persistent-state-retention.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

const timestamp = 2_000_000_000_000;
const old = timestamp - (40 * Retention.DAY_MS);
const fresh = timestamp - 1000;

async function executePolicy(name, options = {}) {
    const policy = Retention.policies({
        timestamp,
        batchSize: 64,
        activityRowsPerPair: 16,
        activityMaxRows: 1000,
        toolOutcomeMaxRows: 1000,
        llmTurnMaxRows: 1000,
        conversationMaxUncompactedRows: 64,
        ...options
    }).find((candidate) => candidate.name === name);
    assert(policy, `missing retention policy ${name}`);
    return Database.execute(policy.statement, `test-retention:${name}`);
}

async function scalar(sql, params = []) {
    return Number((await Database.execute([sql, params], 'test-retention:scalar'))[0]?.value || 0);
}

async function run() {
    await Database.execute(['INSERT INTO accounts(username, password) VALUES (?, ?)', ['retention', 'test']]);
    for (const [name, classId] of [['RetentionPlayer', 0], ['RetentionBot', 1]]) {
        await Database.execute([
            `INSERT INTO characters(username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
             VALUES ('retention', ?, ?, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`,
            [name, classId]
        ]);
    }
    const characters = await Database.execute(['SELECT id, name FROM characters ORDER BY id']);
    const playerId = Number(characters.find((row) => row.name === 'RetentionPlayer').id);
    const botId = Number(characters.find((row) => row.name === 'RetentionBot').id);

    const conversation = await Database.execute([
        `INSERT INTO bot_conversations(playerId, botId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?)`,
        [playerId, botId, old, fresh]
    ]);
    const conversationId = Number(conversation.insertId);
    await Database.execute([
        `WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 73)
         INSERT INTO bot_conversation_messages
             (conversationId, turnId, role, createdAt, turnOrdinal, compacted)
         SELECT ?, 'conversation-' || value, 'player',
             CASE WHEN value <= 2 THEN ? ELSE ? END,
             value,
             CASE WHEN value <= 3 THEN 1 ELSE 0 END
         FROM seq`,
        [conversationId, old, fresh]
    ]);
    assert.strictEqual((await executePolicy('conversation_compacted_age')).affectedRows, 2);
    assert.strictEqual((await executePolicy('conversation_uncompacted_cap')).affectedRows, 6);
    assert.strictEqual(await scalar(
        'SELECT COUNT(*) value FROM bot_conversation_messages WHERE conversationId = ? AND compacted = 0',
        [conversationId]
    ), 64, 'emergency conversation fence must retain the newest uncompacted window');
    assert.strictEqual(await scalar(
        'SELECT COUNT(*) value FROM bot_conversation_messages WHERE conversationId = ? AND compacted = 1',
        [conversationId]
    ), 1, 'fresh compacted dialogue remains available for short-term diagnostics');

    await Database.execute([
        `WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 1025)
         INSERT INTO bot_activity_journal
             (playerId, botId, eventType, summary, weight, createdAt, updatedAt)
         SELECT ?, ?, 'test', 'event', 1,
             CASE WHEN value <= 2 THEN ? ELSE ? END,
             CASE WHEN value <= 2 THEN ? ELSE ? END
         FROM seq`,
        [playerId, botId, old, fresh, old, fresh]
    ]);
    assert.strictEqual((await executePolicy('activity_age')).affectedRows, 2);
    assert.strictEqual((await executePolicy('activity_pair_cap', { batchSize: 3 })).affectedRows, 3);
    assert.strictEqual((await executePolicy('activity_global_cap')).affectedRows, 20);
    assert.strictEqual(await scalar('SELECT COUNT(*) value FROM bot_activity_journal'), 1000,
        'journal must have both a per-pair working-set cap and a global emergency cap');

    await Database.execute([
        `WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 1005)
         INSERT INTO bot_tool_outcomes(botId, toolName, outcome, createdAt)
         SELECT ?, 'test_tool', 'ok', CASE WHEN value <= 2 THEN ? ELSE ? END FROM seq`,
        [botId, old, fresh]
    ]);
    assert.strictEqual((await executePolicy('tool_outcome_age')).affectedRows, 2);
    assert.strictEqual((await executePolicy('tool_outcome_cap')).affectedRows, 3);
    assert.strictEqual(await scalar('SELECT COUNT(*) value FROM bot_tool_outcomes'), 1000);

    await Database.execute([
        `WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 1005)
         INSERT INTO bot_llm_turns(turnId, botId, eventType, state, startedAt, finishedAt)
         SELECT 'terminal-' || value, ?, 'test', 'completed',
             CASE WHEN value <= 2 THEN ? ELSE ? END,
             CASE WHEN value <= 2 THEN ? ELSE ? END
         FROM seq`,
        [botId, old, fresh, old, fresh]
    ]);
    await Database.execute([
        `INSERT INTO bot_llm_turns(turnId, botId, eventType, state, startedAt) VALUES
         ('stale-queued', ?, 'test', 'queued', ?),
         ('stale-running', ?, 'test', 'running', ?),
         ('fresh-running', ?, 'test', 'running', ?)`,
        [botId, old, botId, old, botId, fresh]
    ]);
    assert.strictEqual((await executePolicy('llm_terminal_age')).affectedRows, 2);
    assert.strictEqual((await executePolicy('llm_terminal_cap')).affectedRows, 3);
    assert.strictEqual((await executePolicy('llm_stale_active')).affectedRows, 2);
    assert.strictEqual(await scalar("SELECT COUNT(*) value FROM bot_llm_turns WHERE state IN ('completed', 'failed')"), 1000);
    assert.strictEqual(await scalar("SELECT COUNT(*) value FROM bot_llm_turns WHERE state IN ('queued', 'running')"), 1,
        'only a fresh in-flight audit row may survive stale-active retention');

    const agePlan = await Database.execute([
        'EXPLAIN QUERY PLAN SELECT id FROM bot_activity_journal WHERE updatedAt < ? ORDER BY updatedAt, id LIMIT 64',
        [timestamp]
    ]);
    assert(agePlan.some((row) => String(row.detail).includes('bot_activity_journal_retention_age')),
        'age retention must use its timestamp index');
    const pairPlan = await Database.execute([
        `EXPLAIN QUERY PLAN SELECT id FROM bot_activity_journal
         WHERE botId = ? AND playerId IS ? ORDER BY updatedAt DESC, id DESC LIMIT 64`,
        [botId, playerId]
    ]);
    assert(pairPlan.some((row) => String(row.detail).includes('bot_activity_journal_pair_retention')),
        'pair retention must use its bot/player working-set index');

    Retention.reset();
    const names = [];
    for (let index = 0; index < Retention.policies().length; index++) {
        const result = await Retention.runNextBatch({ timestamp, batchSize: 1 });
        names.push(result.policy);
        if (index < Retention.policies().length - 1) assert.strictEqual(result.cycleComplete, false);
        else assert.strictEqual(result.cycleComplete, true);
    }
    assert.deepStrictEqual(names, Retention.policies().map((policy) => policy.name),
        'maintenance must round-robin every policy and expose a finite pass boundary');

    console.log('Persistent state retention checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
});
