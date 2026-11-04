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

const policyOptions = (options = {}) => ({
    timestamp,
    batchSize: 64,
    activityRowsPerPair: 16,
    activityMaxRows: 1000,
    toolOutcomeMaxRows: 1000,
    llmTurnMaxRows: 1000,
    conversationMaxUncompactedRows: 64,
    ...options
});

// One step of a policy: a bounded statement or two, never more than batchSize deletes.
async function stepPolicy(name, options = {}) {
    const step = await Retention.runPolicy(name, policyOptions(options));
    assert(step.rowsRemoved <= policyOptions(options).batchSize, `${name} removed more than its batch in one step`);
    return step;
}

// A policy run step by step to the end of its sweep: the rows it removed.
async function executePolicy(name, options = {}) {
    let removed = 0;
    for (let steps = 0; steps < 1000; steps++) {
        const step = await stepPolicy(name, options);
        removed += step.rowsRemoved;
        if (!step.more) return { affectedRows: removed, steps: steps + 1 };
    }
    throw new Error(`${name} did not finish its sweep`);
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
    await Database.execute([
        `INSERT INTO characters(username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
         VALUES ('retention', 'RetentionBotTwo', 1, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`
    ]);
    const characters = await Database.execute(['SELECT id, name FROM characters ORDER BY id']);
    const playerId = Number(characters.find((row) => row.name === 'RetentionPlayer').id);
    const botId = Number(characters.find((row) => row.name === 'RetentionBot').id);
    const secondBotId = Number(characters.find((row) => row.name === 'RetentionBotTwo').id);

    // Finished clan actions and goal events are compacted in the history file
    // (HistoryStore.retention, tests/test_history_database.js).

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
    const pairStep = await stepPolicy('activity_pair_cap', { batchSize: 3 });
    assert.deepStrictEqual([pairStep.rowsRemoved, pairStep.more], [3, true],
        'a full batch leaves the pair cap on the same window for the next step');
    const globalCap = await executePolicy('activity_global_cap');
    assert.strictEqual(globalCap.affectedRows, 20);
    assert(globalCap.steps > 1, 'the global cap walks, then deletes, in separate bounded steps');
    assert.strictEqual(await scalar('SELECT COUNT(*) value FROM bot_activity_journal'), 1000,
        'journal must have both a per-pair working-set cap and a global emergency cap');
    // A pair over its cap spread across windows: a second bot's rows start inside
    // the first window and end past it; both pairs end at their newest 16 rows.
    await Database.execute([
        `WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 100)
         INSERT INTO bot_activity_journal
             (playerId, botId, eventType, summary, weight, createdAt, updatedAt)
         SELECT ?, ?, 'test', 'event', 1, ? + value, ? + value FROM seq`,
        [playerId, secondBotId, fresh, fresh]
    ]);
    const pairCap = await executePolicy('activity_pair_cap');
    assert(pairCap.steps > 1, 'the pair cap removes a large overflow over several bounded steps');
    assert.deepStrictEqual(await Database.execute([
        'SELECT botId, COUNT(*) AS value FROM bot_activity_journal GROUP BY botId ORDER BY botId'
    ]).then(rows => rows.map(row => [Number(row.botId), Number(row.value)])), [[botId, 16], [secondBotId, 16]],
    'every pair keeps its 16 newest rows, across window boundaries');
    assert.strictEqual(await scalar('SELECT MIN(updatedAt) value FROM bot_activity_journal WHERE botId = ?', [secondBotId]),
        fresh + 85, 'the pair cap keeps the newest rows of a pair');

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
    // A group cap reads one window of the pair index in its own order: no sort over the journal.
    const pairPlan = await Database.execute([
        `EXPLAIN QUERY PLAN SELECT id, botId, playerId, updatedAt FROM bot_activity_journal
         WHERE botId > ? ORDER BY botId, playerId, updatedAt DESC, id DESC LIMIT ?`,
        [-1, Retention.GROUP_WINDOW_ROWS]
    ]);
    assert(pairPlan.some((row) => String(row.detail).includes('bot_activity_journal_pair_retention')),
        'pair retention must use its bot/player working-set index');
    assert(!pairPlan.some((row) => String(row.detail).includes('TEMP B-TREE')), 'the pair window must not sort the journal');

    // A pass ends once every policy finished its sweep.
    Retention.reset();
    const names = [];
    let complete = false;
    for (let runs = 0; runs < 2000 && !complete; runs++) {
        const result = await Retention.runNextBatch({ timestamp, batchSize: 1 });
        if (names.length < Retention.policyNames().length) names.push(result.policy);
        complete = result.cycleComplete;
    }
    assert.deepStrictEqual(names, Retention.policyNames(), 'maintenance must round-robin every policy');
    assert.strictEqual(complete, true, 'maintenance must expose a finite pass boundary');

    // A player online: retention (PopulationService) removes old rows over several
    // slices, each step a bounded statement or two that holds the DB queue briefly.
    const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
    const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
    const originalProfile = PopulationService.playerActivityProfile;
    const originalLag = Metrics.currentEventLoopLag;
    PopulationService.playerActivityProfile = () => ({ protected: true, realPlayers: 1, connectingPlayers: 0, mode: 'player' });
    Metrics.currentEventLoopLag = () => 0;
    try {
        await Database.execute([
            `WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 300)
             INSERT INTO bot_activity_journal (playerId, botId, eventType, summary, weight, createdAt, updatedAt)
             SELECT ?, ?, 'test', 'event', 1, ?, ? FROM seq`,
            [playerId, secondBotId, old, old]
        ]);
        Retention.reset();
        let slices = 0, longestMs = 0;
        for (let runs = 0; runs < 500 && await scalar('SELECT COUNT(*) value FROM bot_activity_journal WHERE updatedAt < ?', [fresh - 1000]) > 0; runs++) {
            PopulationService.nextStateRetentionAt = 0;
            const startedAt = Date.now();
            const result = await PopulationService.runStateRetention(timestamp);
            if (!result) { await new Promise(resolve => setTimeout(resolve, 20)); continue; }
            slices += 1;
            longestMs = Math.max(longestMs, Date.now() - startedAt);
            assert(result.rowsRemoved <= Math.max(1, Number(invoke('GameServer/Bot/Population/PopulationConfig').stateRetentionBatchSize) || 64));
        }
        assert.strictEqual(await scalar('SELECT COUNT(*) value FROM bot_activity_journal WHERE updatedAt < ?', [fresh - 1000]), 0,
            'with a player online retention must still remove old rows');
        assert(slices > 1, 'the old rows go over several slices, not one long statement');
        assert(longestMs <= 25, `a retention slice must not hold the DB queue past its bound, held ${longestMs} ms`);
    } finally {
        PopulationService.playerActivityProfile = originalProfile;
        Metrics.currentEventLoopLag = originalLag;
    }

    console.log('Persistent state retention checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
});
