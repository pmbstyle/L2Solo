const Protocol = require('./BotDialogueProtocol');

const MAX_READS = 2;
const MAX_ROUNDS = 4;

// Callers own authority and delivery. A mutation is executed at most once;
// a final model round can describe its receipt but cannot issue another one.
async function run({ messages, generate, isRead, read, initialRead, mutate, alive = () => true }) {
    const history = messages.map(message => ({ ...message }));
    const seen = new Set();
    let reads = 0;
    let usage = null;
    let spent = 0;
    let mutation = null;
    let last = null;
    async function readDecision(decision, rounds) {
        const { action, topic, query, entityId, page } = decision;
        const signature = JSON.stringify([action, topic, String(query || '').trim().toLowerCase(),
            ['items', 'npcs', 'skills'].includes(topic) ? null : Number(entityId) || null, Number(page) || 1]);
        const repeated = seen.has(signature);
        const result = repeated ? { ok: false, reason: 'already_read_use_previous_result' } : await read(decision);
        seen.add(signature);
        if (!repeated) reads += 1;
        if (!alive()) return { ok: false, reason: 'actor_changed', usage };
        if (result?.terminalReply) return { action: 'say', reply: result.terminalReply,
            reason: result.replyReason || 'no_recorded_event', confidence: 1,
            usage: rounds === 0 ? Protocol.addUsage(null, {}) : usage, rounds };
        history.push({ role: 'assistant', content: JSON.stringify({ action, topic, query, entityId, page }) });
        history.push({ role: 'user', content: JSON.stringify({ serverToolResult: Protocol.compact(result, { rows: 8 }),
            instruction: 'Use this server result to answer the player or choose the next allowed action. Missing facts are unknown. Use the recorded counts and outcomes exactly.' }) });
        return null;
    }
    if (initialRead) {
        if (!alive()) return { ok: false, reason: 'actor_changed', usage };
        const result = await readDecision(initialRead, 0);
        if (result) return result;
    }
    for (let round = 0; round < MAX_ROUNDS; round++) {
        if (!alive()) return { ok: false, reason: 'actor_changed', usage };
        const final = !!mutation || initialRead?.answerOnly === true || round === MAX_ROUNDS - 1;
        const remaining = Protocol.MAX_TURN_PROMPT_TOKENS - spent;
        const completionRemaining = Protocol.MAX_TURN_COMPLETION_TOKENS - Number(usage?.completionTokens || 0);
        if (remaining < 256 || completionRemaining < 128) break;
        try {
            last = await generate({ messages: history, final, canRead: reads < MAX_READS, round,
                maxCompletionTokens: Math.min(Protocol.MAX_COMPLETION_TOKENS, completionRemaining),
                maxTotalCompletionTokens: completionRemaining, maxTotalPromptTokens: remaining,
                maxPromptTokens: Math.min(Protocol.MAX_PROMPT_TOKENS, remaining) });
        } catch (error) {
            // A failed acknowledgement must not discard or replay a world effect.
            if (mutation) return { ...mutation.decision, reply: '', usage, mutation, rounds: round + 1 };
            throw error;
        }
        usage = Protocol.addUsage(usage, last?.usage);
        spent += Number(last?.accountedPromptTokens ?? (last?.usage?.promptTokens || last?.promptEstimate || Protocol.estimate(history)));
        if (!last || last.ok === false) return mutation
            ? { ...mutation.decision, reply: '', usage, mutation, rounds: round + 1 }
            : { ...last, usage, rounds: round + 1 };
        if (!alive()) return { ok: false, reason: 'actor_changed', usage };
        if (mutation) return { ...mutation.decision, reply: last.reply, usage,
            mutation: { ...mutation, finalReply: last.reply }, rounds: round + 1 };
        if (isRead(last.action)) {
            if (final || reads >= MAX_READS) break;
            const result = await readDecision(last, round + 1);
            if (result) return result;
            continue;
        }
        if (mutate && !['say', 'none'].includes(last.action)) {
            const { executedDecision, ...result } = await mutate(last);
            const decision = executedDecision || last;
            mutation = { decision, result };
            // Native cast/long-workflow receipts already own their delivery.
            const nativePendingReply = result.outcome === 'pending' &&
                !['approach_requested', 'travel_requested', 'restock_requested'].includes(result.effect);
            if (result.replyDelivered || result.playerVisibleReply || nativePendingReply ||
                ['buff_target', 'heal_target'].includes(decision.action) || final) {
                return { ...decision, usage, mutation, rounds: round + 1 };
            }
            history.push({ role: 'assistant', content: JSON.stringify({ action: decision.action }) });
            history.push({ role: 'user', content: JSON.stringify({ serverActionResult: Protocol.compact(result),
                instruction: 'The server processed the request. Reply in character using this receipt. Pending means started/requested, not arrived or completed. A rejected action did not happen. No further actions.' }) });
            continue;
        }
        return { ...last, usage, rounds: round + 1 };
    }
    return mutation ? { ...mutation.decision, reply: '', usage, mutation, rounds: MAX_ROUNDS }
        : { ok: false, reason: 'dialogue_step_limit', usage, rounds: MAX_ROUNDS };
}

module.exports = { run, MAX_READS, MAX_ROUNDS };
