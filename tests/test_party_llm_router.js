const assert = require('assert');

require('../src/Global');

const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const PartyLLMRouter = invoke('GameServer/Bot/AI/PartyLLMRouter');

function response(body) {
    return { ok: true, status: 200, json: async () => body };
}

function candidate(id, name, role = 'dps') {
    return { id, name, role, companion: true, session: { actor: { fetchId: () => id } } };
}

async function main() {
    const originalConfig = options.default.OpenRouter;
    const originalTransport = OpenRouterGateway.setTransport;
    const originalWithObservation = LangfuseTracing.withObservation;
    const observations = [];
    let captured = null;
    try {
        options.default.OpenRouter = {
            enabled: true,
            apiKey: 'party-router-test',
            model: 'test/main',
            partyRouterModel: 'openai/gpt-oss-120b'
        };
        OpenRouterGateway.setTransport(async (_url, init) => {
            captured = JSON.parse(init.body);
            return response({
                choices: [{ message: { content: JSON.stringify({
                    route: 'bot',
                    botId: 2,
                    intent: 'continue_pull',
                    confidence: 0.91,
                    reason: 'recent pull discussion'
                }) } }],
                usage: { prompt_tokens: 40, completion_tokens: 18, total_tokens: 58, cost: 0.0001 }
            });
        });
        LangfuseTracing.withObservation = (name, input, metadata, work) => {
            observations.push({ name, input, metadata });
            return Promise.resolve(work(null));
        };

        const playerSession = { actor: { fetchId: () => 100, fetchName: () => 'Slava' } };
        const candidates = [candidate(1, 'NiceBot', 'tank'), candidate(2, 'Mira', 'healer')];
        const result = await PartyLLMRouter.route({
            text: 'keep it going',
            playerSession,
            candidates,
            selectedBotId: null,
            dialogueState: {
                inFlightBotId: null,
                lastDeliveredBotId: 1,
                recentTurns: [
                    { role: 'bot', botId: 2, text: 'local-only detail', channel: 'local_chat' },
                    { role: 'bot', botId: 1, text: 'I am pulling.', channel: 'party_chat' }
                ]
            }
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.candidate, candidates[1]);
        assert.strictEqual(result.route, 'bot');
        assert.strictEqual(observations[0].name, 'party.router.generation');
        assert.strictEqual(captured.model, 'openai/gpt-oss-120b');
        assert.strictEqual(captured.max_tokens, PartyLLMRouter.ROUTER_MAX_TOKENS);
        assert.strictEqual(captured.max_completion_tokens, undefined);
        assert.strictEqual(captured.temperature, PartyLLMRouter.ROUTER_TEMPERATURE);
        assert.deepStrictEqual(captured.reasoning, { effort: 'low', exclude: true });
        assert.strictEqual(captured.response_format.type, 'json_schema');
        assert.ok(!JSON.stringify(captured.messages).includes('persona'));
        assert.ok(!JSON.stringify(captured.messages).includes('local-only detail'), 'local chat must not leak into party routing context');

        captured = null;
        OpenRouterGateway.setTransport(async () => response({
            choices: [{ message: { content: JSON.stringify({
                route: 'bot', botId: 999, intent: 'bad', confidence: 0.9, reason: 'invalid'
            }) } }]
        }));
        const invalid = await PartyLLMRouter.route({ text: 'who?', playerSession, candidates });
        assert.strictEqual(invalid.ok, false);
        assert.strictEqual(invalid.reason, 'invalid_bot_id');

        OpenRouterGateway.setTransport(async () => response({
            choices: [{ message: { content: JSON.stringify({
                route: 'none',
                botId: null,
                intent: 'clarify_addressee',
                confidence: 0.8,
                reason: 'The addressee is ambiguous; the player should specify which bot.'
            }) } }]
        }));
        const selfCorrected = await PartyLLMRouter.route({ text: 'who should answer?', playerSession, candidates });
        assert.strictEqual(selfCorrected.ok, true);
        assert.strictEqual(selfCorrected.route, 'clarify', 'self-described ambiguity must not become a silent none route');
    } finally {
        options.default.OpenRouter = originalConfig;
        OpenRouterGateway.resetTransport();
        OpenRouterGateway.setTransport = originalTransport;
        LangfuseTracing.withObservation = originalWithObservation;
    }

    console.log('Party LLM router checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
