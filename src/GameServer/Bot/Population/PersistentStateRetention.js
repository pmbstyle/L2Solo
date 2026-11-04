// Bounded retention of the AI memory and audit tables (conversations, activity
// journal, tool outcomes, LLM turns). Called by PopulationService.runStateRetention
// on main, one policy step per run, round-robin. Every statement is bounded by
// construction, so one fits the governor's 12 ms slice on main's DB queue:
// - an age policy deletes <= batchSize rows found on its age index (LIMIT on an
//   indexed range: it reads at most batchSize index entries);
// - a group cap (per conversation, per bot/player pair) ranks one window of
//   GROUP_WINDOW_ROWS index entries in index order (a cursor on the group key
//   resumes the next window next run) and deletes <= batchSize of them;
// - a table cap walks <= WALK_ROWS rows down the rowid per run, counting, until
//   it reaches the cap (the cursor resumes there), then deletes <= batchSize rows
//   below that id per run: the newest `cap` rows as of the walk are kept.
// So a step touches at most ~2k rows or index entries plus batchSize (64)
// deletes; an estimate (not measured) of a few ms from the page cache on the 2015
// laptop. A pass ends when every policy finished its sweep (cycleComplete).
const Database = invoke('Database');

const DAY_MS = 24 * 60 * 60 * 1000;
const WALK_ROWS = 2048;
const GROUP_WINDOW_ROWS = 1024;
const DEFAULTS = Object.freeze({
    batchSize: 64,
    activityRetentionMs: 30 * DAY_MS,
    activityRowsPerPair: 128,
    activityMaxRows: 100000,
    auditRetentionMs: 30 * DAY_MS,
    toolOutcomeMaxRows: 50000,
    llmTurnMaxRows: 50000,
    staleLlmTurnMs: 7 * DAY_MS,
    compactedConversationRetentionMs: DAY_MS,
    conversationMaxUncompactedRows: 512
});

let policyIndex = 0;
// A policy left mid-sweep in this round: the pass is not complete.
let roundUnfinished = false;
// Per policy: the group cap's key cursor, the table cap's walk/delete state.
const cursors = new Map();

function boundedInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function policyOptions(input = {}) {
    return {
        timestamp: boundedInteger(input.timestamp, Date.now(), 0),
        batchSize: boundedInteger(input.batchSize, DEFAULTS.batchSize, 1, 1000),
        activityRetentionMs: boundedInteger(input.activityRetentionMs, DEFAULTS.activityRetentionMs),
        activityRowsPerPair: boundedInteger(input.activityRowsPerPair, DEFAULTS.activityRowsPerPair, 16, 10000),
        activityMaxRows: boundedInteger(input.activityMaxRows, DEFAULTS.activityMaxRows, 1000),
        auditRetentionMs: boundedInteger(input.auditRetentionMs, DEFAULTS.auditRetentionMs),
        toolOutcomeMaxRows: boundedInteger(input.toolOutcomeMaxRows, DEFAULTS.toolOutcomeMaxRows, 1000),
        llmTurnMaxRows: boundedInteger(input.llmTurnMaxRows, DEFAULTS.llmTurnMaxRows, 1000),
        staleLlmTurnMs: boundedInteger(input.staleLlmTurnMs, DEFAULTS.staleLlmTurnMs),
        compactedConversationRetentionMs: boundedInteger(
            input.compactedConversationRetentionMs,
            DEFAULTS.compactedConversationRetentionMs
        ),
        conversationMaxUncompactedRows: boundedInteger(
            input.conversationMaxUncompactedRows,
            DEFAULTS.conversationMaxUncompactedRows,
            64,
            10000
        )
    };
}

function ageStep(name, statement) {
    return {
        name,
        async step(options) {
            const result = await Database.execute(statement(options), `state-retention:${name}`);
            return { rowsRemoved: Math.max(0, Number(result?.affectedRows || 0)), more: false };
        }
    };
}

// Keep the newest `keep` rows of each group: one window of index entries per
// run, ranked in index order (newest first within a group). The last group of a
// full window may be cut: its ranks are still exact for the rows seen, and the
// next window starts at it again. A window that holds one key only (one bot's
// pairs, `subKey` the pair's other column) goes on inside that key from its last
// sub-key until the key's rows end, then past the key.
function groupCap(name, { table, filter, key, subKey, indexOrder, partition, rankOrder, columns, keep }) {
    const where = filter ? `${filter} AND ` : '';
    const range = cursor => (cursor.sub === null
        ? { sql: `${where}${key} > ?`, params: [cursor.key] }
        : { sql: `${where}${key} = ? AND ${subKey} >= ?`, params: [cursor.key, cursor.sub] });
    return {
        name,
        async step(options) {
            const keepRows = keep(options);
            const windowRows = Math.max(GROUP_WINDOW_ROWS, keepRows + options.batchSize);
            const cursor = cursors.get(name) || { key: -1, sub: null };
            const { sql, params } = range(cursor);
            const windowSql = `SELECT id, ${columns} FROM ${table} WHERE ${sql} ORDER BY ${indexOrder} LIMIT ?`;
            const lastSub = subKey ? `(SELECT ${subKey} FROM span ORDER BY ${key} DESC, ${subKey} DESC LIMIT 1)` : 'NULL';
            const [span] = await Database.execute([
                `WITH span AS MATERIALIZED (${windowSql})
                 SELECT MIN(${key}) AS lowKey, MAX(${key}) AS highKey, COUNT(*) AS seen, ${lastSub} AS lastSub FROM span`,
                [...params, windowRows], { read: true }
            ], `state-retention:${name}`);
            const seen = Number(span?.seen || 0);
            let rowsRemoved = 0;
            if (seen > keepRows) {
                const result = await Database.execute([
                    `DELETE FROM ${table} WHERE id IN (
                         SELECT id FROM (
                             SELECT id, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${rankOrder}) AS position
                             FROM (${windowSql})
                         ) WHERE position > ? LIMIT ?
                     )`,
                    [...params, windowRows, keepRows, options.batchSize]
                ], `state-retention:${name}`);
                rowsRemoved = Math.max(0, Number(result?.affectedRows || 0));
            }
            if (rowsRemoved >= options.batchSize) return { rowsRemoved, more: true };
            if (seen < windowRows) {
                // Inside one key: its rows ended, go past it. Otherwise the sweep ended.
                if (cursor.sub !== null) {
                    cursors.set(name, { key: cursor.key, sub: null });
                    return { rowsRemoved, more: true };
                }
                cursors.delete(name);
                return { rowsRemoved, more: false };
            }
            const lowKey = Number(span.lowKey), highKey = Number(span.highKey);
            const sub = span.lastSub === null || span.lastSub === undefined ? null : Number(span.lastSub);
            if (highKey > lowKey) cursors.set(name, { key: highKey - 1, sub: null });
            // One key fills the window: go on inside it from its last sub-key
            // (a full window of one group always removes a batch, so the last
            // sub-key moves on; equal to the start, nothing is left to resume).
            else if (subKey && sub !== null && sub !== cursor.sub) cursors.set(name, { key: highKey, sub });
            else cursors.set(name, { key: highKey, sub: null });
            return { rowsRemoved, more: true };
        }
    };
}

// Keep the newest `max` rows (by id) of a table, or of its `filter` rows.
function tableCap(name, { table, filter, max }) {
    const hit = filter || '1';
    return {
        name,
        async step(options) {
            const maxRows = max(options);
            const state = cursors.get(name);
            if (state?.cutoff) {
                const result = await Database.execute([
                    `DELETE FROM ${table} WHERE id IN (
                         SELECT id FROM ${table} WHERE ${filter ? `${filter} AND ` : ''}id < ?${filter ? '' : ' ORDER BY id'} LIMIT ?
                     )`,
                    [state.cutoff, options.batchSize]
                ], `state-retention:${name}`);
                const rowsRemoved = Math.max(0, Number(result?.affectedRows || 0));
                if (rowsRemoved < options.batchSize) cursors.delete(name);
                return { rowsRemoved, more: rowsRemoved >= options.batchSize };
            }
            let walk = state;
            if (!walk) {
                // MIN and MAX each in its own subquery: SQLite answers each from
                // the rowid b-tree edge; together in one SELECT they scan.
                const [bounds] = await Database.execute([
                    `SELECT (SELECT MIN(id) FROM ${table}) AS low, (SELECT MAX(id) FROM ${table}) AS high`
                ], `state-retention:${name}`);
                const low = Number(bounds?.low || 0), high = Number(bounds?.high || 0);
                // Fewer ids than the cap: fewer rows, nothing to walk.
                if (!high || high - low + 1 <= maxRows) return { rowsRemoved: 0, more: false };
                walk = { cursor: high + 1, counted: 0, cutoff: 0 };
            }
            const [step] = await Database.execute([
                `SELECT MIN(id) AS lowId, COUNT(*) AS seen, SUM(hit) AS hits
                 FROM (SELECT id, (${hit}) AS hit FROM ${table} WHERE id < ? ORDER BY id DESC LIMIT ?)`,
                [walk.cursor, Math.min(WALK_ROWS, maxRows - walk.counted)]
            ], `state-retention:${name}`);
            if (!Number(step?.seen || 0)) {
                cursors.delete(name);
                return { rowsRemoved: 0, more: false };
            }
            walk = { cursor: Number(step.lowId), counted: walk.counted + Number(step.hits || 0), cutoff: 0 };
            if (walk.counted >= maxRows) walk.cutoff = walk.cursor;
            cursors.set(name, walk);
            return { rowsRemoved: 0, more: true };
        }
    };
}

const POLICIES = [
    ageStep('conversation_compacted_age', options => [
        `DELETE FROM bot_conversation_messages
         WHERE id IN (
             SELECT id FROM bot_conversation_messages
             WHERE compacted = 1 AND createdAt < ?
             ORDER BY createdAt, id LIMIT ?
         )`,
        [options.timestamp - options.compactedConversationRetentionMs, options.batchSize]
    ]),
    // Summaries normally compact at 24 messages. This is an emergency fence for
    // a long provider outage: retain a generous recent window per conversation
    // rather than allowing raw dialogue to grow without limit forever.
    groupCap('conversation_uncompacted_cap', {
        table: 'bot_conversation_messages', filter: 'compacted = 0', key: 'conversationId',
        indexOrder: 'conversationId, id DESC', partition: 'conversationId', rankOrder: 'id DESC',
        columns: 'conversationId', keep: options => options.conversationMaxUncompactedRows
    }),
    ageStep('activity_age', options => [
        `DELETE FROM bot_activity_journal
         WHERE id IN (
             SELECT id FROM bot_activity_journal
             WHERE updatedAt < ?
             ORDER BY updatedAt, id LIMIT ?
         )`,
        [options.timestamp - options.activityRetentionMs, options.batchSize]
    ]),
    groupCap('activity_pair_cap', {
        table: 'bot_activity_journal', filter: '', key: 'botId', subKey: 'playerId',
        indexOrder: 'botId, playerId, updatedAt DESC, id DESC', partition: 'botId, playerId',
        rankOrder: 'updatedAt DESC, id DESC', columns: 'botId, playerId, updatedAt',
        keep: options => options.activityRowsPerPair
    }),
    tableCap('activity_global_cap', { table: 'bot_activity_journal', max: options => options.activityMaxRows }),
    ageStep('tool_outcome_age', options => [
        `DELETE FROM bot_tool_outcomes
         WHERE id IN (
             SELECT id FROM bot_tool_outcomes
             WHERE createdAt < ?
             ORDER BY createdAt, id LIMIT ?
         )`,
        [options.timestamp - options.auditRetentionMs, options.batchSize]
    ]),
    tableCap('tool_outcome_cap', { table: 'bot_tool_outcomes', max: options => options.toolOutcomeMaxRows }),
    // No ORDER BY: across two states it would sort every old row; without it
    // each state's range on the retention index stops at the LIMIT.
    ageStep('llm_terminal_age', options => [
        `DELETE FROM bot_llm_turns
         WHERE id IN (
             SELECT id FROM bot_llm_turns
             WHERE state IN ('completed', 'failed')
               AND COALESCE(finishedAt, startedAt, 0) < ?
             LIMIT ?
         )`,
        [options.timestamp - options.auditRetentionMs, options.batchSize]
    ]),
    tableCap('llm_terminal_cap', {
        table: 'bot_llm_turns', filter: "state IN ('completed', 'failed')", max: options => options.llmTurnMaxRows
    }),
    ageStep('llm_stale_active', options => [
        `DELETE FROM bot_llm_turns
         WHERE id IN (
             SELECT id FROM bot_llm_turns
             WHERE state IN ('queued', 'running') AND startedAt < ?
             LIMIT ?
         )`,
        [options.timestamp - options.staleLlmTurnMs, options.batchSize]
    ])
];

// One step of the named policy (a test drives one policy to its end).
async function runPolicy(name, input = {}) {
    const policy = POLICIES.find(candidate => candidate.name === name);
    if (!policy) throw new Error(`unknown_retention_policy:${name}`);
    return policy.step(policyOptions(input));
}

async function runNextBatch(input = {}) {
    const index = policyIndex % POLICIES.length;
    const policy = POLICIES[index];
    const step = await policy.step(policyOptions(input));
    if (step.more) roundUnfinished = true;
    policyIndex = (index + 1) % POLICIES.length;
    const roundEnded = policyIndex === 0;
    const cycleComplete = roundEnded && !roundUnfinished;
    if (roundEnded) roundUnfinished = false;
    return {
        policy: policy.name,
        rowsRemoved: step.rowsRemoved,
        cycleComplete,
        nextPolicy: POLICIES[policyIndex].name
    };
}

module.exports = {
    DAY_MS,
    DEFAULTS,
    WALK_ROWS,
    GROUP_WINDOW_ROWS,
    policyNames: () => POLICIES.map(policy => policy.name),
    runPolicy,
    runNextBatch,
    reset() { policyIndex = 0; roundUnfinished = false; cursors.clear(); },
    policyIndex() { return policyIndex; }
};
