const Database = invoke('Database');

const DAY_MS = 24 * 60 * 60 * 1000;
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

function policies(input = {}) {
    const options = policyOptions(input);
    const batch = options.batchSize;
    return [
        {
            name: 'conversation_compacted_age',
            statement: [
                `DELETE FROM bot_conversation_messages
                 WHERE id IN (
                     SELECT id FROM bot_conversation_messages
                     WHERE compacted = 1 AND createdAt < ?
                     ORDER BY createdAt, id LIMIT ?
                 )`,
                [options.timestamp - options.compactedConversationRetentionMs, batch]
            ]
        },
        {
            // Summaries normally compact at 24 messages. This is an emergency
            // fence for a long provider outage: retain a generous recent
            // window per conversation rather than allowing raw dialogue to
            // grow without limit forever.
            name: 'conversation_uncompacted_cap',
            statement: [
                `WITH overflow AS (
                     SELECT conversationId
                     FROM bot_conversation_messages
                     WHERE compacted = 0
                     GROUP BY conversationId
                     HAVING COUNT(*) > ?
                     ORDER BY conversationId LIMIT 1
                 ), victims AS (
                     SELECT message.id
                     FROM bot_conversation_messages message
                     JOIN overflow ON overflow.conversationId = message.conversationId
                     WHERE message.compacted = 0
                     ORDER BY message.id DESC
                     LIMIT -1 OFFSET ?
                 )
                 DELETE FROM bot_conversation_messages
                 WHERE id IN (SELECT id FROM victims ORDER BY id LIMIT ?)`,
                [options.conversationMaxUncompactedRows, options.conversationMaxUncompactedRows, batch]
            ]
        },
        {
            name: 'activity_age',
            statement: [
                `DELETE FROM bot_activity_journal
                 WHERE id IN (
                     SELECT id FROM bot_activity_journal
                     WHERE updatedAt < ?
                     ORDER BY updatedAt, id LIMIT ?
                 )`,
                [options.timestamp - options.activityRetentionMs, batch]
            ]
        },
        {
            name: 'activity_pair_cap',
            statement: [
                `WITH overflow AS (
                     SELECT botId, playerId
                     FROM bot_activity_journal
                     GROUP BY botId, playerId
                     HAVING COUNT(*) > ?
                     ORDER BY botId, playerId LIMIT 1
                 ), victims AS (
                     SELECT journal.id
                     FROM bot_activity_journal journal
                     JOIN overflow ON overflow.botId = journal.botId
                         AND overflow.playerId IS journal.playerId
                     ORDER BY journal.updatedAt DESC, journal.id DESC
                     LIMIT -1 OFFSET ?
                 )
                 DELETE FROM bot_activity_journal
                 WHERE id IN (SELECT id FROM victims ORDER BY id LIMIT ?)`,
                [options.activityRowsPerPair, options.activityRowsPerPair, batch]
            ]
        },
        {
            name: 'activity_global_cap',
            statement: [
                `WITH cutoff AS (
                     SELECT id FROM bot_activity_journal
                     ORDER BY id DESC LIMIT 1 OFFSET ?
                 )
                 DELETE FROM bot_activity_journal
                 WHERE id IN (
                     SELECT id FROM bot_activity_journal
                     WHERE id <= COALESCE((SELECT id FROM cutoff), 0)
                     ORDER BY id LIMIT ?
                 )`,
                [options.activityMaxRows, batch]
            ]
        },
        {
            name: 'tool_outcome_age',
            statement: [
                `DELETE FROM bot_tool_outcomes
                 WHERE id IN (
                     SELECT id FROM bot_tool_outcomes
                     WHERE createdAt < ?
                     ORDER BY createdAt, id LIMIT ?
                 )`,
                [options.timestamp - options.auditRetentionMs, batch]
            ]
        },
        {
            name: 'tool_outcome_cap',
            statement: [
                `WITH cutoff AS (
                     SELECT id FROM bot_tool_outcomes
                     ORDER BY id DESC LIMIT 1 OFFSET ?
                 )
                 DELETE FROM bot_tool_outcomes
                 WHERE id IN (
                     SELECT id FROM bot_tool_outcomes
                     WHERE id <= COALESCE((SELECT id FROM cutoff), 0)
                     ORDER BY id LIMIT ?
                 )`,
                [options.toolOutcomeMaxRows, batch]
            ]
        },
        {
            name: 'llm_terminal_age',
            statement: [
                `DELETE FROM bot_llm_turns
                 WHERE id IN (
                     SELECT id FROM bot_llm_turns
                     WHERE state IN ('completed', 'failed')
                       AND COALESCE(finishedAt, startedAt, 0) < ?
                     ORDER BY COALESCE(finishedAt, startedAt, 0), id LIMIT ?
                 )`,
                [options.timestamp - options.auditRetentionMs, batch]
            ]
        },
        {
            name: 'llm_terminal_cap',
            statement: [
                `WITH cutoff AS (
                     SELECT id FROM bot_llm_turns
                     WHERE state IN ('completed', 'failed')
                     ORDER BY id DESC LIMIT 1 OFFSET ?
                 )
                 DELETE FROM bot_llm_turns
                 WHERE id IN (
                     SELECT id FROM bot_llm_turns
                     WHERE state IN ('completed', 'failed')
                       AND id <= COALESCE((SELECT id FROM cutoff), 0)
                     ORDER BY id LIMIT ?
                 )`,
                [options.llmTurnMaxRows, batch]
            ]
        },
        {
            name: 'llm_stale_active',
            statement: [
                `DELETE FROM bot_llm_turns
                 WHERE id IN (
                     SELECT id FROM bot_llm_turns
                     WHERE state IN ('queued', 'running') AND startedAt < ?
                     ORDER BY startedAt, id LIMIT ?
                 )`,
                [options.timestamp - options.staleLlmTurnMs, batch]
            ]
        }
    ];
}

async function runNextBatch(input = {}) {
    const available = policies(input);
    const index = policyIndex % available.length;
    const policy = available[index];
    const result = await Database.execute(policy.statement, `state-retention:${policy.name}`);
    policyIndex = (index + 1) % available.length;
    return {
        policy: policy.name,
        rowsRemoved: Math.max(0, Number(result?.affectedRows || 0)),
        cycleComplete: policyIndex === 0,
        nextPolicy: available[policyIndex].name
    };
}

module.exports = {
    DAY_MS,
    DEFAULTS,
    policies,
    runNextBatch,
    reset() { policyIndex = 0; },
    policyIndex() { return policyIndex; }
};
