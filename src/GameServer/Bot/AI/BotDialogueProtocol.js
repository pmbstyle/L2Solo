// Shared wire format for dialogue. A snapshot is reference data; the final
// user message is always the actual utterance, with prior speech in order.
const MAX_PROMPT_TOKENS = 4800;
const MAX_TURN_PROMPT_TOKENS = 14000;
const MAX_COMPLETION_TOKENS = 1200;
const MAX_TURN_COMPLETION_TOKENS = 3600;

function estimate(value) {
    return Math.ceil((typeof value === 'string' ? value : JSON.stringify(value ?? null)).length / 4);
}

function compact(value, { strings = 320, rows = 12, depth = 7 } = {}) {
    if (typeof value === 'string') return value.slice(0, strings);
    if (!value || typeof value !== 'object') return value;
    if (depth <= 0) return null;
    const options = { strings, rows, depth: depth - 1 };
    if (Array.isArray(value)) return value.slice(0, rows).map(row => compact(row, options));
    return Object.fromEntries(Object.entries(value).slice(0, 32)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, compact(entry, options)]));
}

// Remove entire optional records rather than chopping serialized JSON or
// changing an item ID/amount. Missing detail remains obtainable by a read.
function fitContext(value, maxTokens = 1800) {
    const context = JSON.parse(JSON.stringify(value));
    const omitted = [];
    const optional = [
        ['bot', 'inference'], ['bot', 'roleDecision'], ['contextTelemetry'], ['lastDecision'],
        ['bot', 'inventory', 'supplyCatalog'], ['bot', 'inventory'], ['bot', 'equipment'],
        ['bot', 'skills'], ['bot', 'policy'], ['candidateSpots'], ['visiblePlayers'],
        ['contextFragments'], ['recentEvents'], ['members']
    ];
    for (const path of optional) {
        if (estimate(context) <= maxTokens) break;
        const parent = path.slice(0, -1).reduce((entry, key) => entry?.[key], context);
        const key = path[path.length - 1];
        if (key === 'equipment' && parent?.[key]?.source === 'worn_equipment'
            && estimate(parent[key]) <= 360) continue;
        if (parent && parent[key] !== undefined && parent[key] !== null) {
            delete parent[key];
            omitted.push(path.join('.'));
        }
    }
    if (estimate(context) > maxTokens) {
        // An unusually large snapshot may consist of a single field. Keep a
        // small truthful identity, not a falsely capped token counter.
        context.bot = compact(context.bot, { strings: 160, rows: 4, depth: 3 });
        omitted.push('bot.details');
    }
    while (estimate(context) > maxTokens && context.conversation?.recentTurns?.length > 2) context.conversation.recentTurns.shift();
    if (estimate(context) > maxTokens && context.conversation?.summary) context.conversation.summary = context.conversation.summary.slice(0, 160);
    if (estimate(context) > maxTokens && context.bot) {
        context.bot = Object.fromEntries(['id', 'name', 'level', 'classId', 'mode', 'activity', 'vitals', 'clan', 'equipment', 'relationships', 'persona', 'social']
            .filter(key => context.bot[key] !== undefined).map(key => [key, compact(context.bot[key], { strings: 96, rows: 3, depth: 2 })]));
    }
    if (omitted.length) context.omitted = omitted;
    if (estimate(context) > maxTokens) return { bot: { id: context.bot?.id,
        name: String(context.bot?.name || '').slice(0, 48), mode: String(context.bot?.mode || '').slice(0, 32) },
    omitted: ['context_details'] };
    return context;
}

function messages(system, payload, options = {}) {
    const conversation = payload.conversation || {};
    const text = String(payload.playerMessage ?? payload.message ?? '').trim();
    const source = options.publicTurns || conversation.recentTurns || [];
    const turns = source.slice(-8).filter(turn => turn.role === 'player' || turn.role === 'bot');
    // Ingress already persisted the current player turn. Send it only once.
    if (turns.at(-1)?.role === 'player' && String(turns.at(-1).text).trim() === text) turns.pop();
    const reference = { ...payload };
    delete reference.playerMessage;
    delete reference.message;
    delete reference.recentClanTurns;
    delete reference.candidateSpots;
    reference.conversation = {
        ...(conversation.summary ? { summary: String(conversation.summary).slice(0, 1200) } : {}),
        actions: turns.filter(turn => !['say', 'none'].includes(turn.meta?.action) && (turn.meta?.actionResult || turn.meta?.serverApplied))
            .map(turn => ({ action: turn.meta.action, ...turn.meta.actionResult, serverApplied: turn.meta.serverApplied }))
    };
    // Older assemblers put the same history in these fragments too.
    if (reference.contextFragments) reference.contextFragments = reference.contextFragments
        .filter(fragment => !['recent_dialogue', 'conversation_summary'].includes(fragment.id));
    return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(fitContext(reference)) },
        ...turns.map(turn => ({
            role: turn.role === 'bot' ? 'assistant' : 'user',
            content: options.publicTurns && turn.name ? `${turn.name}: ${turn.text}` : String(turn.text)
        })),
        { role: 'user', content: text }
    ];
}

function requestSize(messages, responseSchema) {
    return estimate({ messages, response_format: { type: 'json_schema', json_schema: { ...responseSchema, strict: true } } });
}

function fitMessages(input, responseSchema, maxTokens = MAX_PROMPT_TOKENS) {
    const output = input.map(message => ({ ...message }));
    const firstTool = output.findIndex((message, index) => {
        if (index < 2 || message.role !== 'assistant') return false;
        try { return !!JSON.parse(message.content).action; } catch (_) { return false; }
    });
    let preserveFrom = firstTool < 0 ? output.length - 1 : firstTool - 1;
    if (requestSize(output, responseSchema) > maxTokens) {
        try {
            const reference = JSON.parse(output[1].content);
            const overhead = requestSize(output, responseSchema) - estimate(output[1].content);
            output[1].content = JSON.stringify(fitContext(reference, Math.max(160, maxTokens - overhead - 80)));
        } catch (_) { /* The caller may have supplied a plain dialogue. */ }
    }
    while (requestSize(output, responseSchema) > maxTokens && preserveFrom > 2) {
        // The snapshot and current utterance are retained. Completed old
        // exchanges are the first history to leave a bounded request.
        const count = preserveFrom > 3 && output[2]?.role === 'user' && output[3]?.role === 'assistant' ? 2 : 1;
        output.splice(2, count);
        preserveFrom -= count;
    }
    return requestSize(output, responseSchema) <= maxTokens ? output : null;
}

function addUsage(total, next) {
    if (!next) return total;
    const result = { ...(total || {}) };
    for (const key of ['promptTokens', 'completionTokens', 'reasoningTokens', 'visibleCompletionTokens',
        'totalTokens', 'cachedPromptTokens', 'cacheWriteTokens']) result[key] = Number(result[key] || 0) + Number(next[key] || 0);
    result.cost = next.cost === null || next.cost === undefined || total?.cost === null
        ? null : Number(total?.cost || 0) + Number(next.cost);
    return result;
}

module.exports = { MAX_PROMPT_TOKENS, MAX_TURN_PROMPT_TOKENS, MAX_COMPLETION_TOKENS, MAX_TURN_COMPLETION_TOKENS,
    estimate, compact, fitContext, messages, requestSize, fitMessages, addUsage };
