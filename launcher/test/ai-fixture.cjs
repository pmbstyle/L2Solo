'use strict';

const reply = content => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
function answer(body) {
    if (body.tools) {
        if (body.tool_choice === 'none') return reply(JSON.parse(body.messages.at(-1).content).diagnosticCode);
        return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'launcher_diagnostic', arguments: '{"topic":"status"}' } }] } }] };
    }
    switch (body.response_format?.json_schema.name) {
    case 'bot_brain_decision': {
        const receipt = body.messages.at(-1).content;
        const result = receipt.includes('serverToolResult')
            ? { action: 'say', reply: `I have ${JSON.parse(receipt).serverToolResult.rows[0].count.toLocaleString('en-US')} Adena.`, reason: 'tool_result', confidence: 1, topic: null }
            : { action: 'inspect_self', reply: '', topic: 'inventory', query: 'Adena', reason: 'read_requested', confidence: 1 };
        // Strict schemas require all optional properties, with null defaults.
        const schema = body.response_format.json_schema.schema;
        for (const key of schema.required) if (!Object.hasOwn(result, key)) result[key] = null;
        return reply(result);
    }
    case 'party_chat_route': return reply({ route: 'bot', botId: 101, intent: 'conversation', confidence: 1, reason: 'direct_address' });
    case 'clan_strategy': return reply({ choice: 'treasury', reason: 'progression' });
    case 'clan_goal_decision': return reply({ candidateId: 'gear-1', route: 'spoil', reasonCode: 'better_value' });
    case 'clan_title_assignments': return reply({ assignments: [{ characterId: 101, title: 'Dawn Keeper' }, { characterId: 102, title: 'Iron Guard' }] });
    default: return reply('Welcome back, adventurer!');
    }
}
function transport(handler = answer) {
    const calls = [];
    const fetcher = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, options, body });
        return new Response(JSON.stringify(await handler(body, calls.length)), { status: 200 });
    };
    return { fetcher, calls };
}
module.exports = { reply, answer, transport };
