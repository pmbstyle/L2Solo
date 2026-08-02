const Database = invoke('Database');

function id(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value, max = 160) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function json(value, max = 12000) {
    try { return JSON.stringify(value ?? null).slice(0, max); } catch (_) { return '{}'; }
}

function turnId(input) {
    return text(input?.turnId || input?.requestId, 128) || null;
}

function begin(input = {}) {
    const turn = turnId(input);
    const botId = id(input.botId);
    if (!turn || !botId || !Database.isReady?.()) return Promise.resolve(false);
    const playerId = id(input.playerId);
    return Database.execute([`
        INSERT INTO bot_llm_turns
            (turnId, playerId, botId, eventType, channel, state, requestId, traceId, startedAt, metaJson)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
        ON CONFLICT(turnId) DO UPDATE SET
            requestId = excluded.requestId,
            traceId = COALESCE(excluded.traceId, bot_llm_turns.traceId),
            metaJson = excluded.metaJson
    `, [
        turn,
        playerId,
        botId,
        text(input.eventType || 'player_chat', 48),
        text(input.channel || '', 32),
        text(input.requestId, 128) || null,
        text(input.traceId, 128) || null,
        Number(input.startedAt || Date.now()),
        json(input.meta)
    ]], 'bot-llm-turn:begin').then(() => true).catch(() => false);
}

function markStarted(input = {}) {
    const turn = turnId(input);
    if (!turn || !Database.isReady?.()) return Promise.resolve(false);
    return Database.execute([`
        UPDATE bot_llm_turns
        SET state = 'running', startedAt = COALESCE(startedAt, ?), traceId = COALESCE(?, traceId)
        WHERE turnId = ?
    `, [Number(input.startedAt || Date.now()), text(input.traceId, 128) || null, turn]], 'bot-llm-turn:started')
        .then(() => true).catch(() => false);
}

function finish(input = {}) {
    const turn = turnId(input);
    if (!turn || !Database.isReady?.()) return Promise.resolve(false);
    const usage = input.usage || {};
    const state = input.ok === false ? 'failed' : 'completed';
    return Database.execute([`
        UPDATE bot_llm_turns
        SET state = ?, finishedAt = ?, outcome = ?, model = ?,
            traceId = COALESCE(?, traceId), promptTokens = ?, completionTokens = ?, totalTokens = ?, cost = ?, error = ?, metaJson = ?
        WHERE turnId = ?
    `, [
        state,
        Number(input.finishedAt || Date.now()),
        text(input.outcome || (input.ok === false ? 'failed' : 'success'), 64),
        text(input.model, 160) || null,
        text(input.traceId, 128) || null,
        Number(usage.promptTokens || 0),
        Number(usage.completionTokens || 0),
        Number(usage.totalTokens || 0),
        Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null,
        text(input.error, 240),
        json(input.meta),
        turn
    ]], 'bot-llm-turn:finish').then(() => true).catch(() => false);
}

module.exports = { begin, markStarted, finish };
