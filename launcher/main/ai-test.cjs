'use strict';

const { randomUUID, randomInt } = require('node:crypto');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const bool = (value, fallback = false) => value === undefined || value === '' ? fallback
    : ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
const choice = values => ({ type: 'string', enum: values });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const STRATEGY_REASONS = ['progression', 'readiness', 'leader_preference', 'member_welfare', 'opportunity', 'recovery', 'keep_course'];
const GOAL_REASONS = ['mandatory_progression', 'goal_fulfilled', 'goal_blocked', 'better_clan_readiness', 'better_value', 'fair_distribution', 'keep_current', 'deterministic_fallback'];
const READ_TOPICS = ['', 'inventory', 'equipment', 'skills', 'party', 'goals', 'relationship', 'relationships', 'recent_events', 'clan', 'clan_history',
    'items', 'item', 'item_sources', 'npcs', 'npc', 'recipes', 'recipe', 'skill', 'movement', 'party', 'combat', 'equipment', 'trade', 'supplies'];

// This module also works with older installed servers. Keep the wire contracts
// aligned with OpenRouterGateway, BotDialogueRunner and the clan brains.
function testConfig(config, env = process.env) {
    const legacy = !config.AI;
    const values = config.AI || config.OpenRouter || {};
    const prefix = legacy ? 'OPENROUTER' : 'L2NODE_AI';
    const clan = config.ClanSimulation || {};
    return {
        enabled: bool(values.enabled),
        apiUrl: String(env.L2NODE_AI_API_URL || (legacy && env.OPENROUTER_API_URL) || values.apiUrl || (legacy ? OPENROUTER_URL : '')).trim(),
        apiKey: String(env[`${prefix}_API_KEY`] || values.apiKey || ''),
        model: String(env[`${prefix}_MODEL`] || values.model || ''),
        partyRouterModel: String(env[`${prefix}_PARTY_ROUTER_MODEL`] || values.partyRouterModel || env[`${prefix}_MODEL`] || values.model || '').trim(),
        temperature: values.temperature === undefined || String(values.temperature).trim() === '' ? null : Number(values.temperature),
        reasoningEffort: ['off', 'low', 'medium', 'high'].includes(String(values.reasoningEffort).toLowerCase()) ? String(values.reasoningEffort).toLowerCase() : 'off',
        completionLimitParam: ['max_tokens', 'max_completion_tokens'].includes(values.completionLimitParam) ? values.completionLimitParam : legacy ? 'max_completion_tokens' : 'max_tokens',
        strictSchema: bool(values.strictSchema),
        providerOrder: String(values.providerOrder || '').split(',').map(value => value.trim()).filter(Boolean),
        providerSort: String(values.providerSort || '').trim(),
        allowFallbacks: bool(values.allowFallbacks, true),
        requireParameters: bool(values.requireParameters, true),
        clansEnabled: bool(env.CLAN_SIMULATION_ENABLED ?? clan.enabled, true),
        clanGoals: bool(env.CLAN_SIMULATION_LLM_GOALS_ENABLED ?? clan.llmGoalManagementEnabled, true),
        clanTitles: bool(env.CLAN_SIMULATION_LLM_TITLES_ENABLED ?? clan.llmTitleManagementEnabled),
        clanStrategy: bool(env.CLAN_SIMULATION_STRATEGY_ENABLED ?? clan.strategicManagementEnabled, true)
    };
}

function configurationError(config) {
    let url;
    try { url = new URL(config.apiUrl); } catch { return 'Enter a complete AI endpoint URL.'; }
    if (!['http:', 'https:'].includes(url.protocol)) return 'AI endpoint must use HTTP or HTTPS.';
    if (!config.model.trim()) return 'Enter a model identifier.';
    if (isOpenRouter(config) && !config.apiKey.trim()) return 'Enter your OpenRouter API key.';
    return null;
}

function isOpenRouter(config) { return config.apiUrl.replace(/\/+$/, '') === OPENROUTER_URL; }

function strictSchema(schema) {
    const result = { ...schema };
    if (result.items) result.items = strictSchema(result.items);
    if (result.properties) {
        const required = new Set(result.required || []);
        result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => {
            const property = strictSchema(value);
            if (!required.has(key)) {
                property.type = [...new Set([...(Array.isArray(property.type) ? property.type : [property.type]), 'null'])];
                if (property.enum) property.enum = [...property.enum, null];
            }
            return [key, property];
        }));
        result.required = Object.keys(result.properties);
        result.additionalProperties = false;
    }
    return result;
}

function requestBody(config, messages, { model = config.model, schema, name, maxTokens = 512, reasoningEffort = config.reasoningEffort, ...extra } = {}) {
    const body = { model, messages, [config.completionLimitParam]: maxTokens, ...extra };
    if (Number.isFinite(config.temperature)) body.temperature = config.temperature;
    if (isOpenRouter(config)) {
        body.usage = { include: true };
        body.provider = { allow_fallbacks: config.allowFallbacks, require_parameters: config.requireParameters };
        if (config.providerOrder.length) body.provider.order = config.providerOrder;
        if (config.providerSort) body.provider.sort = config.providerSort;
        if (reasoningEffort !== 'off') body.reasoning = { effort: reasoningEffort, exclude: true };
    } else body.reasoning_effort = reasoningEffort === 'off' ? 'none' : reasoningEffort;
    if (schema) body.response_format = { type: 'json_schema', json_schema: {
        name, strict: true, schema: config.strictSchema ? strictSchema(schema) : schema
    } };
    return body;
}

function validate(value, schema, at = 'response') {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(type) && !(type === 'number' && Number.isInteger(value) && types.includes('integer'))) throw new Error(`${at}: expected ${types.join(' or ')}.`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at}: value is outside the supplied choices.`);
    if (type === 'object') {
        for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key}: missing required field.`);
        for (const [key, entry] of Object.entries(value)) {
            if (schema.properties[key]) validate(entry, schema.properties[key], `${at}.${key}`);
            else if (schema.additionalProperties === false) throw new Error(`${at}.${key}: unexpected field.`);
        }
    }
    if (type === 'array') {
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${at}: wrong number of entries.`);
        value.forEach((entry, index) => validate(entry, schema.items, `${at}[${index}]`));
    }
    if (type === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error(`${at}: number is outside the allowed range.`);
    if (type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) throw new Error(`${at}: invalid text length.`);
    return value;
}

function assistant(payload) {
    const entry = payload?.choices?.[0];
    if (entry?.finish_reason === 'length') throw new Error('Model output was truncated at the token limit.');
    if (entry?.message?.refusal) throw new Error('The model refused the diagnostic request.');
    if (!entry?.message) throw new Error('The endpoint returned no assistant message.');
    return entry.message;
}

function textReply(message) {
    if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('The endpoint returned an empty assistant reply.');
    return message.content.trim();
}

function jsonReply(message, schema) {
    const raw = textReply(message).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('The model did not return valid JSON.'); }
    return validate(value, schema);
}

function probes(config) {
    const messages = (system, data) => [{ role: 'system', content: system }, { role: 'user', content: typeof data === 'string' ? data : JSON.stringify(data) }];
    const structured = async (send, schema, name, input, options = {}) => jsonReply(await send(messages(
        'You are a Lineage 2 bot. Use only supplied facts and choices. Return JSON matching the supplied schema.', input
    ), { schema, name, ...options }), config.strictSchema ? strictSchema(schema) : schema);
    const clanSkip = !config.clansEnabled ? 'Clan simulation is disabled.' : null;
    return [
        { id: 'chat', label: 'Test chat', run: async send => textReply(await send(messages(
            'You are a friendly Lineage 2 player. Reply briefly in English.', 'Hello! Ready for another adventure?'
        ))) },
        { id: 'gameTools', label: 'Game tools · JSON actions', run: async send => {
            const schema = object({ action: choice(['inspect_self', 'say']), reply: { type: 'string' }, reason: { type: 'string' },
                confidence: { type: 'number', minimum: 0, maximum: 1 }, partyIntent: choice(['none', 'membership']), topic: choice(READ_TOPICS),
                query: { type: 'string' }, entityId: { type: 'integer', minimum: 0 }, page: { type: 'integer', minimum: 1, maximum: 1000 }
            }, ['action', 'reply', 'reason', 'confidence']);
            const spec = { schema, name: 'bot_brain_decision', maxTokens: 1200 };
            const history = [
                { role: 'system', content: 'You are Aria, a Lineage 2 player character. The game server executes your JSON actions. '
                    + 'These application actions are requested through the action field in your JSON response, not through native API function calls. '
                    + 'inspect_self with topic inventory reads your inventory; say sends your reply to the player. '
                    + 'Request a read when the needed fact is missing, then use the serverToolResult returned by the game server to answer. '
                    + 'Never invent inventory quantities. Return JSON matching the supplied schema.' },
                { role: 'user', content: JSON.stringify({ bot: { id: 101, name: 'Aria' }, tools: [
                    { action: 'inspect_self', description: 'Read your inventory. Set topic to inventory; query can filter item names.' },
                    { action: 'say', description: 'Reply to the player using known facts.' }
                ] }) },
                { role: 'user', content: 'How much Adena do you have? Check your inventory first, then tell me the exact amount.' }
            ];
            const effective = config.strictSchema ? strictSchema(schema) : schema;
            const decision = jsonReply(await send(history, spec), effective);
            if (decision.action !== 'inspect_self' || decision.topic !== 'inventory') throw new Error(
                `Expected inspect_self with topic inventory; received action=${decision.action}, topic=${decision.topic ?? '(missing)'}.`
            );
            const query = String(decision.query || '').trim().toLowerCase();
            if (!'adena'.includes(query) || Number(decision.page || 1) !== 1) throw new Error('The requested inventory filter or page does not include Adena.');
            const amount = randomInt(10000, 100000);
            history.push({ role: 'assistant', content: JSON.stringify({ action: decision.action, topic: decision.topic,
                query: decision.query, entityId: decision.entityId, page: decision.page }) },
                { role: 'user', content: JSON.stringify({ serverToolResult: { ok: true, source: 'current_inventory', historyEvidence: false,
                    page: 1, total: 1, hasMore: false, rows: [{ selfId: 57, name: 'Adena', count: amount, equipped: false, grade: 'none' }] },
                instruction: 'Use this server result to answer the player or choose the next allowed action. Missing data is unknown.' }) });
            const final = jsonReply(await send(history, spec), effective);
            const ungrouped = final.reply.replace(/[\s,_'’]/g, '');
            if (final.action !== 'say' || !new RegExp(`(?<!\\d)${amount}(?!\\d)`).test(ungrouped)) throw new Error('The model did not use the inventory amount returned by the game tool in its final reply.');
            return final.reply;
        } },
        { id: 'nativeTools', label: 'Native API function calling', required: false, run: async send => {
            const parameters = object({ topic: choice(['status']) });
            const tools = [{ type: 'function', function: { name: 'launcher_diagnostic', description: 'Read the diagnostic code. This is a simulated read.', parameters } }];
            const history = messages('Read the diagnostic code using launcher_diagnostic, then reply with that exact code.', 'What is the diagnostic code?');
            const first = await send(history, { tools, tool_choice: 'auto' });
            const calls = first.tool_calls;
            if (!Array.isArray(calls) || calls.length !== 1 || calls[0].type !== 'function' || calls[0].function?.name !== 'launcher_diagnostic' || !calls[0].id) throw new Error('The model did not return the requested function call.');
            let args;
            try { args = JSON.parse(calls[0].function.arguments); } catch { throw new Error('Function arguments are not valid JSON.'); }
            validate(args, parameters, 'function arguments');
            const code = `L2SOLO_${randomUUID().slice(0, 8)}`;
            history.push({ role: 'assistant', content: first.content || null, tool_calls: calls },
                { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ diagnosticCode: code }) });
            const final = await send(history, { tools, tool_choice: 'none' });
            if (final.tool_calls?.length) throw new Error('The model requested another function instead of completing its reply.');
            const reply = textReply(final);
            if (!reply.includes(code)) throw new Error('The model did not use the function result in its final reply.');
            return reply;
        } },
        { id: 'partyRouter', label: 'Party chat routing', model: config.partyRouterModel, run: async send => {
            if (!config.partyRouterModel) throw new Error('The party routing model is blank. Clear the field to use the main model or enter a model identifier.');
            const schema = object({ route: choice(['bot', 'party', 'clarify', 'none']), botId: { type: ['number', 'null'] },
                intent: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string' } });
            const result = await structured(send, schema, 'party_chat_route', {
                message: 'Aria, hello! How are you?', channel: 'party_chat', candidates: [{ id: 101, name: 'Aria', role: 'healer' }, { id: 102, name: 'Borin', role: 'tank' }],
                instruction: 'Route this directly addressed greeting to the named bot.'
            });
            if (result.route !== 'bot' || result.botId !== 101) throw new Error('The router did not select the explicitly addressed party member.');
            return JSON.stringify(result);
        } },
        { id: 'clanStrategy', label: 'Clan strategic goals', skip: clanSkip || (!config.clanGoals ? 'AI clan goals are disabled.' : !config.clanStrategy ? 'Strategic management is disabled; testing goal selection below.' : null), timeoutMs: 10000, run: async send => {
            const schema = object({ choice: choice(['treasury', 'recruit']), reason: choice(STRATEGY_REASONS) });
            return JSON.stringify(await structured(send, schema, 'clan_strategy', {
                clan: { level: 1, adena: 10000, members: 5 }, current: null,
                candidates: [{ id: 'treasury', objective: 'treasury', description: 'Save for clan level 2.' }, { id: 'recruit', objective: 'recruit', description: 'Recruit more members.' }]
            }, { maxTokens: 128, reasoningEffort: 'off' }));
        } },
        { id: 'clanGoals', label: 'Clan goal selection', skip: clanSkip || (!config.clanGoals ? 'AI clan goals are disabled.' : config.clanStrategy ? 'Strategic management replaces per-item goal selection.' : null), timeoutMs: 10000, run: async send => {
            const schema = object({ candidateId: choice(['gear-1', 'gear-2']), route: choice(['spoil', 'farm']), reasonCode: choice(GOAL_REASONS) });
            const candidates = [{ id: 'gear-1', route: { kind: 'spoil' }, description: 'Gather materials for a shield.' }, { id: 'gear-2', route: { kind: 'farm' }, description: 'Gather adena for armour.' }];
            const result = await structured(send, schema, 'clan_goal_decision', { candidates, instruction: 'Choose one candidate and its exact route.' }, { maxTokens: 120, reasoningEffort: 'off' });
            if (candidates.find(entry => entry.id === result.candidateId)?.route.kind !== result.route) throw new Error('The model selected a route that does not belong to its chosen goal.');
            return JSON.stringify(result);
        } },
        { id: 'clanTitles', label: 'Clan member titles', skip: clanSkip || (!config.clanTitles ? 'AI clan titles are disabled.' : null), timeoutMs: 10000, run: async send => {
            const schema = object({ assignments: { type: 'array', minItems: 2, maxItems: 2, items: object({ characterId: { type: 'integer', enum: [101, 102] }, title: { type: 'string', minLength: 2, maxLength: 32 } }) } });
            const result = await structured(send, schema, 'clan_title_assignments', {
                clan: { name: 'Dawn Guard', level: 3 }, members: [{ characterId: 101, class: 'Bishop', leader: true }, { characterId: 102, class: 'Paladin' }], assignOnlyMemberIds: [101, 102],
                instruction: 'Assign every requested member exactly once. Use unique English titles of 2 to 24 ASCII characters, starting with a letter or digit. No player names or profanity.'
            }, { maxTokens: 120, reasoningEffort: 'off' });
            const ids = new Set(), titles = new Set();
            for (const assignment of result.assignments) {
                const title = assignment.title.trim().replace(/\s+/g, ' ');
                if (ids.has(assignment.characterId) || titles.has(title.toLowerCase()) || !/^[A-Za-z0-9][A-Za-z0-9 '&+.,:!?-]{1,31}$/.test(title)) throw new Error('Titles contain duplicate members, duplicate titles, or characters the game does not accept.');
                ids.add(assignment.characterId); titles.add(title.toLowerCase());
            }
            return JSON.stringify(result);
        } }
    ];
}

async function runAiTest(config, { fetcher = fetch, onProgress = () => {}, timeoutMs, signal } = {}) {
    const checks = probes(config).map(probe => ({ id: probe.id, label: probe.label, model: probe.model ?? config.model,
        required: probe.required !== false, status: probe.skip ? 'skipped' : 'pending', message: probe.skip || '', latencyMs: null }));
    const result = { phase: 'testing', checks, checkedAt: null };
    const publish = () => onProgress(structuredClone(result));
    if (!config.enabled || configurationError(config)) {
        result.phase = config.enabled ? 'error' : 'disabled';
        result.message = config.enabled ? configurationError(config) : 'Enable AI to run the checks.';
        result.checks = [];
        publish();
        return result;
    }
    const clean = value => {
        let message = String(value);
        if (config.apiKey) message = message.split(config.apiKey).join('[redacted]');
        return message.replace(/\s+/g, ' ').trim().slice(0, 700);
    };
    const startedAt = Date.now();
    publish();
    for (const [index, probe] of probes(config).entries()) {
        if (signal?.aborted) break;
        const check = checks[index];
        if (probe.skip) continue;
        check.status = 'testing';
        publish();
        const start = Date.now();
        let lastReply = '';
        const controller = new AbortController();
        const cancel = () => controller.abort();
        const limit = timeoutMs ?? probe.timeoutMs ?? 30000;
        const timer = setTimeout(() => controller.abort(), limit);
        // Race as well as abort: a non-cooperative transport must not hang the UI.
        let rejectTimeout;
        const timedOut = new Promise((_, reject) => { rejectTimeout = reject; });
        controller.signal.addEventListener('abort', () => rejectTimeout(new Error(signal?.aborted ? 'Diagnostic cancelled.' : `Timed out after ${limit / 1000} seconds.`)), { once: true });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        const send = async (messages, options = {}) => {
            if (controller.signal.aborted) throw new Error('Diagnostic request was cancelled.');
            const headers = { 'Content-Type': 'application/json' };
            if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
            if (isOpenRouter(config)) { headers['HTTP-Referer'] = 'https://l2solo.com'; headers['X-OpenRouter-Title'] = 'L2Solo Launcher'; }
            const response = await fetcher(config.apiUrl, { method: 'POST', headers, signal: controller.signal,
                body: JSON.stringify(requestBody(config, messages, { model: check.model, ...options })) });
            const raw = await response.text();
            let payload;
            try { payload = JSON.parse(raw); } catch { throw new Error(`HTTP ${response.status}: the endpoint did not return JSON.`); }
            if (!response.ok || payload.error) throw new Error(`HTTP ${response.status}: ${clean(payload.error?.message || payload.error || response.statusText)}`);
            const message = payload?.choices?.[0]?.message;
            if (typeof message?.content === 'string') lastReply = clean(message.content);
            else if (message?.tool_calls) lastReply = clean(JSON.stringify(message.tool_calls));
            return assistant(payload);
        };
        try {
            check.reply = clean(await Promise.race([probe.run(send), timedOut]));
            check.status = 'passed';
            check.message = 'Passed';
        } catch (error) {
            check.status = 'failed';
            check.message = clean(error.message);
            if (lastReply) check.reply = lastReply;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            check.latencyMs = Date.now() - start;
        }
        publish();
    }
    result.phase = signal?.aborted ? 'cancelled' : checks.some(check => check.required && check.status === 'failed') ? 'failed' : 'passed';
    result.message = result.phase === 'cancelled' ? 'Test cancelled because the selected settings changed.'
        : result.phase === 'passed' ? 'All enabled game features passed the sample checks.' : 'Some game features failed. See the results below.';
    result.latencyMs = Date.now() - startedAt;
    result.checkedAt = Date.now();
    publish();
    return result;
}

module.exports = { testConfig, configurationError, requestBody, runAiTest };
