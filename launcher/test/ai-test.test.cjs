'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { once } = require('node:events');
const { testConfig, configurationError, requestBody, runAiTest } = require('../main/ai-test.cjs');
const { settings, readConfig, saveSettings, previewConfig } = require('../main/config.cjs');
const { Controller } = require('../main/controller.cjs');
const { reply, answer, transport } = require('./ai-fixture.cjs');

const config = changes => testConfig({ AI: { enabled: 'true', apiUrl: 'http://localhost:1234/v1/chat/completions', model: 'dialogue-model',
    partyRouterModel: 'routing-model', strictSchema: 'true' }, ClanSimulation: { llmTitleManagementEnabled: 'true' }, ...changes }, {});
const check = (result, id) => result.checks.find(entry => entry.id === id);

test('real HTTP diagnostics exercise chat, both tool round trips, router model and enabled clan APIs', async t => {
    const bodies = [];
    const server = http.createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        bodies.push(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(answer(body)));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const cfg = { ...config(), apiUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions` };
    const progress = [];
    const result = await runAiTest(cfg, { onProgress: value => progress.push(value) });
    assert.equal(result.phase, 'passed');
    assert.equal(result.checks.filter(entry => entry.status === 'passed').length, 6);
    assert.equal(check(result, 'clanGoals').status, 'skipped');
    assert.equal(bodies.length, 8, 'both tool checks must include a second model request');
    assert.equal(bodies.find(body => body.response_format?.json_schema.name === 'party_chat_route').model, 'routing-model');
    assert.ok(progress.some(value => check(value, 'chat').status === 'testing' && check(value, 'clanTitles').status === 'pending'));
    assert.ok(progress.some(value => check(value, 'chat').status === 'passed' && check(value, 'clanTitles').status === 'testing'));
    assert.ok(result.checks.filter(entry => entry.status === 'passed').every(entry => entry.reply && entry.latencyMs >= 0));
    assert.ok(bodies.filter(body => body.response_format?.json_schema.name.startsWith('clan_')).every(body => body.reasoning_effort === 'none'));
    const gameRequests = bodies.filter(body => body.response_format?.json_schema.name === 'bot_brain_decision');
    assert.match(gameRequests[0].messages[0].content, /game server executes your JSON actions/i);
    assert.equal(JSON.parse(gameRequests[0].messages[1].content).bot.name, 'Aria');
    const receipt = JSON.parse(gameRequests[1].messages.at(-1).content).serverToolResult;
    assert.equal(receipt.source, 'current_inventory');
    assert.equal(receipt.rows[0].selfId, 57);
    assert.ok(check(result, 'gameTools').reply.replace(/,/g, '').includes(String(receipt.rows[0].count)));
});

test('legacy goal selection is tested when strategy is off; disabled clan features do not make requests', async () => {
    const local = transport();
    let result = await runAiTest(config({ ClanSimulation: { strategicManagementEnabled: 'false', llmTitleManagementEnabled: 'false' } }), local);
    assert.equal(check(result, 'clanGoals').status, 'passed');
    assert.equal(check(result, 'clanStrategy').status, 'skipped');
    assert.equal(check(result, 'clanTitles').status, 'skipped');
    assert.equal(local.calls.length, 7);
    const disabled = transport();
    result = await runAiTest(config({ ClanSimulation: { enabled: 'false', llmTitleManagementEnabled: 'true' } }), disabled);
    assert.ok(result.checks.filter(entry => entry.id.startsWith('clan')).every(entry => entry.status === 'skipped'));
    assert.equal(disabled.calls.length, 6);
});

test('HTTP 200 does not hide malformed JSON, invented IDs, invalid choices or duplicate clan titles', async () => {
    const bad = transport(body => {
        switch (body.response_format?.json_schema.name) {
        case 'bot_brain_decision': return reply('This is not JSON.');
        case 'party_chat_route': return reply({ route: 'bot', botId: 999, intent: 'conversation', confidence: 1, reason: 'invented' });
        case 'clan_strategy': return reply({ choice: 'invented-goal', reason: 'progression' });
        case 'clan_title_assignments': return reply({ assignments: [{ characterId: 101, title: 'Dawn Keeper' }, { characterId: 101, title: 'Iron Guard' }] });
        default: return answer(body);
        }
    });
    const result = await runAiTest(config(), bad);
    assert.equal(result.phase, 'failed');
    for (const id of ['gameTools', 'partyRouter', 'clanStrategy', 'clanTitles']) assert.equal(check(result, id).status, 'failed', id);
    assert.equal(check(result, 'chat').status, 'passed');
    assert.equal(check(result, 'nativeTools').status, 'passed', 'a failed probe must not stop other probes');
});

test('game tools must be called and their returned value must be used; native functions are optional', async () => {
    for (const fakeResult of [false, true]) {
        const local = transport(body => {
            if (body.response_format?.json_schema.name === 'bot_brain_decision') {
                if (!fakeResult || body.messages.at(-1).content.includes('serverToolResult')) {
                    const payload = answer(body);
                    const decision = JSON.parse(payload.choices[0].message.content);
                    return reply({ ...decision, action: 'say', reply: 'I guessed it.' });
                }
            }
            return answer(body);
        });
        const result = await runAiTest(config(), local);
        assert.equal(check(result, 'gameTools').status, 'failed');
        assert.match(check(result, 'gameTools').message, fakeResult ? /inventory amount/ : /Expected inspect_self/);
        assert.match(check(result, 'gameTools').reply, /I guessed it/);
    }
    const result = await runAiTest(config(), transport(body => body.tools ? reply('Native tools are unavailable.') : answer(body)));
    assert.equal(result.phase, 'passed');
    assert.equal(check(result, 'nativeTools').status, 'failed');
    assert.equal(check(result, 'nativeTools').required, false);
});

test('an inspect action without its inventory topic fails with the actual model response', async () => {
    const result = await runAiTest(config(), transport(body => {
        const payload = answer(body);
        if (body.response_format?.json_schema.name !== 'bot_brain_decision') return payload;
        const decision = JSON.parse(payload.choices[0].message.content);
        return reply({ ...decision, topic: null, reply: 'I cannot read that inventory.' });
    }));
    const game = check(result, 'gameTools');
    assert.equal(game.status, 'failed');
    assert.match(game.message, /action=inspect_self, topic=\(missing\)/);
    assert.match(game.reply, /I cannot read that inventory/);
});

test('inventory diagnostics reject filters or pages that would not return the requested currency', async () => {
    for (const fields of [{ query: 'Sword' }, { page: 2 }]) {
        const local = transport(body => {
            const payload = answer(body);
            if (body.response_format?.json_schema.name !== 'bot_brain_decision') return payload;
            return reply({ ...JSON.parse(payload.choices[0].message.content), ...fields });
        });
        const result = await runAiTest(config(), local);
        assert.equal(check(result, 'gameTools').status, 'failed');
        assert.match(check(result, 'gameTools').message, /filter or page/);
        assert.equal(local.calls.filter(call => call.body.response_format?.json_schema.name === 'bot_brain_decision').length, 1);
    }
});

test('native function calling must finish with an answer instead of another tool request', async () => {
    const result = await runAiTest(config(), transport(body => {
        const payload = answer(body);
        if (body.tool_choice === 'none') payload.choices[0].message.tool_calls = [{ id: 'unexpected', type: 'function', function: { name: 'launcher_diagnostic', arguments: '{"topic":"status"}' } }];
        return payload;
    }));
    assert.equal(check(result, 'nativeTools').status, 'failed');
    assert.match(check(result, 'nativeTools').message, /another function/);
});

test('an explicitly blank routing model cannot pass by testing the main model instead', async () => {
    const cfg = testConfig({ AI: { enabled: 'true', apiUrl: 'http://localhost:1234/v1/chat/completions', model: 'main', partyRouterModel: '  ' } }, {});
    const local = transport();
    const result = await runAiTest(cfg, local);
    assert.equal(check(result, 'partyRouter').status, 'failed');
    assert.equal(check(result, 'partyRouter').model, '');
    assert.match(check(result, 'partyRouter').message, /routing model is blank/);
    assert.equal(local.calls.some(call => call.body.response_format?.json_schema.name === 'party_chat_route'), false);
});

test('empty replies, truncation, provider errors and timeouts produce failures without exposing keys', async () => {
    for (const payload of [reply('top-secret'), reply(''), { choices: [{ finish_reason: 'length', message: { content: 'half an answer top-secret' } }] }, { error: { message: 'bad key: top-secret' } }]) {
        const result = await runAiTest({ ...config(), apiKey: 'top-secret' }, { fetcher: async () => new Response(JSON.stringify(payload)) });
        assert.equal(result.phase, 'failed');
        assert.ok(result.checks.filter(entry => !['skipped', 'passed'].includes(entry.status)).every(entry => entry.status === 'failed'));
        assert.equal(JSON.stringify(result).includes('top-secret'), false);
    }
    const result = await runAiTest(config(), { timeoutMs: 5, fetcher: () => new Promise(() => {}) });
    assert.equal(result.phase, 'failed');
    assert.match(check(result, 'chat').message, /Timed out/);
});

test('disabled AI and invalid configuration send no requests; provider selection follows runtime precedence', async () => {
    const local = transport();
    assert.equal((await runAiTest({ ...config(), enabled: false }, local)).phase, 'disabled');
    assert.equal((await runAiTest({ ...config(), model: '' }, local)).phase, 'error');
    assert.equal(local.calls.length, 0);
    const legacy = testConfig({ OpenRouter: { enabled: 'true', model: 'legacy' } }, { OPENROUTER_MODEL: 'env-legacy', OPENROUTER_API_KEY: 'legacy-key' });
    assert.equal(legacy.model, 'env-legacy');
    assert.equal(legacy.apiUrl, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(configurationError(legacy), null);
    const custom = testConfig({ AI: { enabled: 'true', apiUrl: 'http://localhost:1', model: 'custom', strictSchema: 'true' }, OpenRouter: { apiKey: 'legacy-key' } }, { OPENROUTER_MODEL: 'ignored', OPENROUTER_API_KEY: 'ignored' });
    assert.equal(custom.model, 'custom');
    assert.equal(custom.apiKey, '');
    assert.equal(custom.completionLimitParam, 'max_tokens');
    const overrides = testConfig({ AI: { enabled: 'true', model: 'main' } }, { L2NODE_AI_MODEL: 'env-main', L2NODE_AI_PARTY_ROUTER_MODEL: 'env-router', CLAN_SIMULATION_LLM_GOALS_ENABLED: 'false' });
    assert.equal(overrides.model, 'env-main'); assert.equal(overrides.partyRouterModel, 'env-router'); assert.equal(overrides.clanGoals, false);
    const body = requestBody({ ...legacy, providerOrder: ['OpenAI'], providerSort: 'price', reasoningEffort: 'low', allowFallbacks: false }, []);
    assert.deepEqual(body.provider, { order: ['OpenAI'], sort: 'price', allow_fallbacks: false, require_parameters: true });
    assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
    assert.equal(body.max_completion_tokens, 512);
});

test('the strict-schema checkbox reflects the runtime default for an existing custom AI provider', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-ai-schema-default-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/default.ini'), '[AI]\nenabled=true\napiUrl=http://localhost:1234/v1/chat/completions\nmodel=local\n');
    const schemaField = () => settings(root).find(section => section.id === 'AI').fields.find(field => field.key === 'strictSchema');
    assert.equal(schemaField().value, String(testConfig(readConfig(root), {}).strictSchema));
    assert.equal(schemaField().value, 'false');
    fs.writeFileSync(path.join(root, 'config/local.ini'), '[AI]\nstrictSchema=true\n');
    assert.equal(schemaField().value, 'true');
    assert.equal(testConfig(readConfig(root), {}).strictSchema, true);
});

test('cancelling diagnostics stops subsequent requests and stale results cannot overwrite changed settings', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-ai-cancel-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/default.ini'), '[AI]\nenabled=true\napiUrl=http://localhost:1234/v1/chat/completions\nmodel=original\n');
    let calls = 0;
    const controller = new Controller({ userData: path.join(root, 'profile'), nodePath: process.execPath,
        fetcher: () => { calls++; return new Promise(() => {}); } });
    controller.state.root = root; controller.state.installed = true;
    const running = controller.testAi();
    assert.equal(controller.state.aiTest.phase, 'testing');
    await saveSettings(root, [{ section: 'AI', key: 'model', value: 'changed' }]);
    controller.getSettings();
    await running;
    assert.equal(controller.state.aiTest, null);
    assert.equal(calls, 1);
    assert.equal(controller.aiTestPromise, null);
});

test('cancelling as a probe starts must not send a request or wait for its timeout', async () => {
    const controller = new AbortController();
    const local = transport();
    const result = await runAiTest(config(), { ...local, signal: controller.signal, onProgress: result => {
        if (check(result, 'chat').status === 'testing') controller.abort();
    } });
    assert.equal(result.phase, 'cancelled');
    assert.equal(local.calls.length, 0);
});

test('clan AI controls move to AI while edits and previews preserve their original INI keys', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-ai-settings-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'config'));
    fs.copyFileSync(path.resolve(__dirname, '../../config/default.ini'), path.join(root, 'config/default.ini'));
    const original = '; Keep this comment\n[ClanSimulation]\nllmGoalManagementEnabled = true\nllmTitleManagementEnabled = false\n';
    fs.writeFileSync(path.join(root, 'config/local.ini'), original);
    const groups = settings(root);
    for (const key of ['llmGoalManagementEnabled', 'llmTitleManagementEnabled']) {
        assert.equal(groups.find(group => group.id === 'ClanSimulation').fields.some(field => field.key === key), false);
        assert.equal(groups.find(group => group.id === 'AI').fields.find(field => field.key === key).section, 'ClanSimulation');
    }
    const changes = [{ section: 'ClanSimulation', key: 'llmTitleManagementEnabled', value: 'true' }];
    assert.equal(previewConfig(root, changes).ClanSimulation.llmTitleManagementEnabled, 'true');
    assert.equal(fs.readFileSync(path.join(root, 'config/local.ini'), 'utf8'), original, 'testing form values must not save settings');
    assert.throws(() => previewConfig(root, [{ section: 'AI', key: 'llmTitleManagementEnabled', value: 'true' }]), /Unknown server setting/);
    assert.throws(() => previewConfig(root, [{ ...changes[0], value: 'maybe' }]), /Expected true or false/);
    await saveSettings(root, changes);
    assert.equal(readConfig(root).ClanSimulation.llmTitleManagementEnabled, 'true');
    assert.equal(readConfig(root).AI, undefined, 'moving a control must not change provider precedence');
    assert.match(fs.readFileSync(path.join(root, 'config/local.ini'), 'utf8'), /^; Keep this comment/);

    const local = transport();
    const controller = new Controller({ userData: path.join(root, 'profile'), nodePath: process.execPath, fetcher: local.fetcher });
    controller.state.root = root; controller.state.installed = true;
    const form = [
        { section: 'AI', key: 'enabled', value: 'true' },
        { section: 'AI', key: 'apiUrl', value: 'http://localhost:1234/v1/chat/completions' },
        { section: 'AI', key: 'model', value: 'preview-model' }
    ];
    const before = fs.readFileSync(path.join(root, 'config/local.ini'), 'utf8');
    await controller.testAi(form);
    assert.equal(controller.state.aiTest.phase, 'passed');
    assert.equal(local.calls[0].body.model, 'preview-model');
    assert.equal(fs.readFileSync(path.join(root, 'config/local.ini'), 'utf8'), before);
    await saveSettings(root, form);
    controller.getSettings();
    assert.equal(controller.state.aiTest.phase, 'passed', 'saving the tested values preserves their result');
    await saveSettings(root, [{ section: 'AI', key: 'model', value: 'changed-model' }]);
    controller.getSettings();
    assert.equal(controller.state.aiTest, null, 'a different configuration must not retain a passing result');
});

// Evaluate the actual server contract builders with inert services. No world,
// database, trace or game action is started by this parity check.
function serverModule(relative, services = {}) {
    const filename = path.resolve(__dirname, '../../src', relative);
    const module = { exports: {} };
    const imports = {
        './ClanStrategyPolicy': 'GameServer/Clan/ClanStrategyPolicy.js',
        './BotDialogueKnowledge': 'GameServer/Bot/AI/BotDialogueKnowledge.js',
        './BotDialogueParty': 'GameServer/Bot/AI/BotDialogueParty.js'
    };
    const context = { module, exports: module.exports, require: name => imports[name] ? serverModule(imports[name]) : {},
        invoke: name => services[name] || {}, options: { default: {} }, process: { env: {} } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return { ...module.exports, schema: module.exports.schema || context.schema };
}

test('game, router and clan probe schemas and strict-schema conversion match the server contracts', async () => {
    const local = transport();
    await runAiTest(config(), local);
    await runAiTest(config({ ClanSimulation: { strategicManagementEnabled: 'false' } }), local);
    const json = value => JSON.parse(JSON.stringify(value));
    const schema = name => local.calls.find(call => call.body.response_format?.json_schema.name === name).body.response_format.json_schema.schema;
    const gateway = serverModule('GameServer/Bot/AI/OpenRouterGateway.js');
    const normalize = value => json(gateway.responseSchemaForConfig({ schema: value }, { strictSchema: true }).schema);
    const strategy = serverModule('GameServer/Clan/ClanStrategyService.js');
    assert.deepEqual(schema('clan_strategy'), normalize(strategy.schema([{ id: 'treasury' }, { id: 'recruit' }]).schema));
    const goals = serverModule('GameServer/Clan/ClanBrain.js');
    assert.deepEqual(schema('clan_goal_decision'), normalize(goals.responseSchema([{ id: 'gear-1', route: { kind: 'spoil' } }, { id: 'gear-2', route: { kind: 'farm' } }])));
    const titles = serverModule('GameServer/Clan/ClanTitleBrain.js');
    assert.deepEqual(schema('clan_title_assignments'), normalize(titles.responseSchema([101, 102])));
    const router = serverModule('GameServer/Bot/AI/PartyLlmRouter.js');
    assert.deepEqual(schema('party_chat_route'), normalize(router.ROUTER_SCHEMA.schema));
    const brain = serverModule('GameServer/Bot/AI/BotBrain.js');
    const withoutDescriptions = value => JSON.parse(JSON.stringify(value, (key, entry) => key === 'description' ? undefined : entry));
    assert.deepEqual(schema('bot_brain_decision'), withoutDescriptions(normalize(brain.schema(['inspect_self', 'say']))));
});
