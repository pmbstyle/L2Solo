// Manual local-inference evaluation. Uses isolated in-memory actors, never a
// running game server or its database. Reports include actual provider usage.
const fs = require('node:fs');
const nodePath = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
require('../src/Global');
const Brain = invoke('GameServer/Bot/AI/BotBrain');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Manager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World');
const Knowledge = invoke('GameServer/Bot/AI/BotDialogueKnowledge');
const Tracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Tools = invoke('GameServer/Bot/AI/BotAgentTools');

async function main() {
    const cfg = Gateway.config();
    if (cfg.provider !== 'openai-compatible' || !/^(127\.|192\.168\.|10\.|localhost$)/.test(new URL(cfg.apiUrl).hostname)) {
        throw new Error('This evaluation requires a configured local inference endpoint.');
    }
    const actor = (id, name) => ({ fetchId: () => id, fetchName: () => name, fetchLevel: () => 20,
        fetchClassId: () => 0, fetchHp: () => 72, fetchMaxHp: () => 100, fetchMp: () => 45, fetchMaxMp: () => 100,
        fetchKarma: () => 0, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchDestId: () => 0, fetchIsOnline: () => true, isDead: () => false });
    const player = { accountId: 'evaluation_player', actor: actor(990001, 'Player') };
    const coal = { fetchId: () => 77, fetchSelfId: () => 1870, fetchName: () => 'Coal', fetchAmount: () => 23,
        fetchEquipped: () => false, fetchRank: () => 'none' };
    const bot = { accountId: 'bot_evaluation', actor: { ...actor(990002, 'Mira'), backpack: { fetchItems: () => [coal] } },
        plan: 'resting', partyCompanion: true, followPlayerSession: player };
    const state = { name: 'Mira', level: 20, classId: 0, mode: 'resting', role: 'dps',
        vitals: { hpPct: 72, mpPct: 45 }, persona: { primaryDrive: 'social', archetype: 'steadfast_helper',
            textCard: 'Warm to familiar friends, prefers reliable company.',
            dialogueVoice: 'Casual and direct, with personal opinions. Can tease friends or say no.' } };
    const saved = { tell: Manager.botTell, request: Gateway.request, root: Tracing.withRootObservation,
        user: World.user, read: Knowledge.execute, execute: Tools.execute };
    let calls = [], reads = [], delivered = [], mutations = [], allowedMutation = null, finish;
    const report = { at: new Date().toISOString(), model: cfg.model, endpoint: cfg.apiUrl, checks: [] };
    const casesArg = process.argv.find(arg => arg.startsWith('--cases='));
    const selected = casesArg ? new Set(casesArg.slice(8).split(',')) : null;
    const run = name => !selected || selected.has(name);
    try {
        World.user = { sessions: [player, bot] };
        Manager.botTell = (_bot, _player, text) => delivered.push(text);
        Knowledge.execute = async (decision, context) => {
            const result = await saved.read(decision, context);
            reads.push({ action: decision.action, topic: decision.topic, query: decision.query, entityId: decision.entityId, result });
            return result;
        };
        Tools.execute = async (subject, decision, ...args) => {
            if (!['say', 'none', 'list_safe_loadouts', 'list_party_candidates'].includes(decision.action)) {
                if (subject !== bot || decision.action !== allowedMutation) throw new Error('Unexpected mutation in isolated evaluation');
                mutations.push(decision.action);
            }
            return saved.execute(subject, decision, ...args);
        };
        Gateway.request = async spec => {
            const result = await saved.request({ ...spec, timeoutMs: 30000 });
            calls.push({ source: spec.source, ok: result.ok, reason: result.reason,
                usage: result.usage, latencyMs: result.telemetry?.latencyMs,
                actions: spec.responseSchema?.schema?.properties?.action?.enum });
            return result;
        };
        Tracing.withRootObservation = (_name, _input, _metadata, work) => Promise.resolve(work(null))
            .then(result => { finish?.(result); return result; });
        const context = (text, history = []) => ({ playerSession: player, source: 'local_evaluation',
            requestId: `evaluation:${report.checks.length}:${Date.now()}`,
            conversation: { recentTurns: history, summary: null },
            assembledContext: { bot: state, fragments: [], conversation: { recentTurns: history, summary: null } } });

        // Compare the same greeting/state/model against the checked-in code.
        if (process.argv.includes('--baseline')) {
            const file = nodePath.resolve(__dirname, '../src/GameServer/Bot/AI/BotBrain.js');
            let source = execFileSync('git', ['show', 'HEAD:src/GameServer/Bot/AI/BotBrain.js'], { encoding: 'utf8' });
            const styleSource = execFileSync('git', ['show', 'HEAD:src/GameServer/Bot/AI/BotDialogueStyle.js'], { encoding: 'utf8' });
            const style = new Function('module', `${styleSource}; return module.exports;`)({ exports: {} });
            source = source.replace("invoke('GameServer/Bot/AI/BotDialogueStyle')", JSON.stringify(style));
            const original = new Module(file, module); original.filename = file; original.paths = Module._nodeModulePaths(nodePath.dirname(file));
            original._compile(source + '\nmodule.exports.evaluation = { userPayload, requestDecision };', file);
            const text = 'Hey! How are you doing?', ctx = context(text);
            const payload = original.exports.evaluation.userPayload('player_chat', bot, { available: false },
                [{ id: 990001, name: 'Player', level: 20, hpPct: 72, distance: 0 }], text, ctx);
            const at = Date.now();
            const result = await original.exports.evaluation.requestDecision(payload, cfg, bot, ctx, []);
            report.baseline = { ms: Date.now() - at, reply: result.reply, usage: result.usage };
            console.log(JSON.stringify({ baseline: report.baseline }));
        }

        async function check(name, text, history = []) {
            calls = []; reads = []; delivered = []; mutations = [];
            const ctx = context(text, history);
            const at = Date.now();
            const result = await new Promise((resolve, reject) => {
                finish = resolve;
                if (!Brain.maybeThink(bot, 'player_chat', { available: false }, text, ctx)) reject(new Error('Dialogue did not start'));
            });
            await bot.lastConversationWrite;
            const row = { name, text, ok: result?.ok !== false && delivered.some(Boolean), ms: Date.now() - at, reply: delivered.join(' '),
                action: result.action, usage: result.usage, rounds: result.rounds, calls: [...calls], reads: [...reads], mutations: [...mutations] };
            report.checks.push(row);
            console.log(JSON.stringify({ name, ok: row.ok, reply: row.reply, ms: row.ms, rounds: row.rounds,
                promptTokens: row.usage?.promptTokens, completionTokens: row.usage?.completionTokens,
                reads: row.reads.map(read => `${read.action}:${read.topic}`) }));
            return row;
        }
        if (run('greeting')) await check('greeting', 'Hey! How are you doing?');
        if (run('music') || run('followup')) {
            const music = await check('music', 'What music do you like?');
            if (run('followup')) await check('followup', 'Why that kind in particular?', [
                { role: 'player', text: 'What music do you like?' }, { role: 'bot', text: music.reply }
            ]);
        }
        let inventory;
        if (run('inventory')) {
            inventory = await check('inventory', 'Do you have any Coal? How many? Check your inventory if you are unsure.');
            inventory.exactInventoryCount = /\b23\b/.test(inventory.reply) && inventory.reads.some(read => read.topic === 'inventory');
        }
        if (run('sources')) {
            const sources = await check('sources', 'Which mobs drop Coal? Check the catalogue and name one by its exact game name.');
            const names = sources.reads.flatMap(read => read.result.rows || []).map(row => row.name).filter(Boolean);
            sources.catalogueGrounded = names.some(name => sources.reply.includes(name));
        }
        if (run('unknown_history')) {
            const unknown = await check('unknown_history', 'Remember when we killed Antharas yesterday? What dropped for you?');
            unknown.noInventedEvent = unknown.reads.some(read => read.action === 'recall_event' && read.result.terminalReply === unknown.reply);
        }
        if (run('stay')) {
            allowedMutation = 'stay_here';
            const stay = await check('stay', 'Stay here, do not follow me. I will be back soon.');
            allowedMutation = null;
            stay.nativeActionApplied = bot.botStay === true && bot.stayLocation?.locX === bot.actor.fetchLocX() &&
                stay.mutations.length === 1 && stay.mutations[0] === 'stay_here';
        }
        if (['cold_gear', 'cold_grade', 'cold_social'].some(run)) {
            // Exercise the real cold prompt/runner without delivery, persistence
            // or world actions. The supplied facts are isolated test fixtures.
            const file = nodePath.resolve(__dirname, '../src/GameServer/Bot/AI/BotRemoteChat.js');
            const remote = new Module(file, module); remote.filename = file;
            remote.paths = Module._nodeModulePaths(nodePath.dirname(file));
            remote._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.evaluation = { requestLlmReply };', file);
            const worn = { source: 'worn_equipment', total: 2, hasMore: false, rows: [
                { selfId: 167, name: 'Scalpel', grade: 'd', equipped: true, slot: 7 },
                { selfId: 348, name: 'Scale Mail', grade: 'd', equipped: true, slot: 10 }
            ] };
            const shop = { purpose: 'shop_listings_not_equipped_items', side: 'sell', items: [
                { selfId: 181, name: 'Mace of Miracle', grade: 'd', count: 1, unitPrice: 500 },
                { selfId: 25, name: 'Piece Bone Breastplate', grade: 'none', count: 1, unitPrice: 100 }
            ] };
            async function cold(name, text, history = [], extra = {}) {
                calls = []; reads = [];
                const at = Date.now();
                const payload = { event: 'cold_chat', playerMessage: text,
                    player: { name: 'Player', level: 20 }, bot: { ...state, clan: { id: 0, name: null }, equipment: worn, ...extra },
                    shop, social: { relationship: 'familiar' }, availability: { available: false, reason: 'prefers_solo' },
                    conversation: { recentTurns: history } };
                const result = await remote.exports.evaluation.requestLlmReply(payload, cfg,
                    { turnId: `evaluation:${name}` }, { characterId: 990002, inventory: {} }, player);
                const row = { name, text, ok: Boolean(result.data?.reply), reply: result.data?.reply,
                    usage: result.usage, ms: Date.now() - at, calls: [...calls], reads: [...reads] };
                report.checks.push(row);
                console.log(JSON.stringify(row));
                return row;
            }
            if (run('cold_gear')) {
                const row = await cold('cold_gear', 'Are you in a clan and what is your gear?');
                row.catalogueGrounded = /Scalpel/i.test(row.reply || '') && !/off.screen|snapshot/i.test(row.reply || '');
            }
            if (run('cold_grade')) {
                const row = await cold('cold_grade', 'Is Piece Bone Breastplate D grade? And is that really what you wear?', [
                    { role: 'player', text: 'What is your gear?' },
                    { role: 'bot', text: 'A Mace of Miracle and Piece Bone Breastplate.' }
                ]);
                row.catalogueGrounded = /Scalpel|Scale Mail/i.test(row.reply || '') && /no.grade|non.grade|ungraded/i.test(row.reply || '');
            }
            if (run('cold_social')) {
                const row = await cold('cold_social', 'Do you have friends or enemies?', [], {
                    relationships: { source: 'personal_relationship_memory', completeHistory: false, rows: [
                        { name: 'Vane', relationship: 'hostile', reasons: [{ type: 'attacked' }] },
                        { name: 'Ally', relationship: 'friendly', reasons: [{ type: 'helped_in_combat' }] }
                    ] }
                });
                row.catalogueGrounded = /Vane/i.test(row.reply || '') && /Ally/i.test(row.reply || '');
            }
        }
        fs.mkdirSync(nodePath.resolve(__dirname, '../tmp'), { recursive: true });
        const output = nodePath.resolve(__dirname, '../tmp/bot-dialogue-evaluation.json');
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        console.log(`Evaluation saved to ${output}`);
        if (report.checks.some(row => !row.ok || row.catalogueGrounded === false || row.noInventedEvent === false || row.nativeActionApplied === false) || inventory?.exactInventoryCount === false) process.exitCode = 1;
    } finally {
        Manager.botTell = saved.tell; Gateway.request = saved.request; Tracing.withRootObservation = saved.root;
        World.user = saved.user; Knowledge.execute = saved.read; Tools.execute = saved.execute; Budget.reset();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
