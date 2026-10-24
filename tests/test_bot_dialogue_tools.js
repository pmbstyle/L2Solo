const assert = require('assert');
require('../src/Global');
const Protocol = invoke('GameServer/Bot/AI/BotDialogueProtocol');
const Runner = invoke('GameServer/Bot/AI/BotDialogueRunner');
const Knowledge = invoke('GameServer/Bot/AI/BotDialogueKnowledge');
const Brain = invoke('GameServer/Bot/AI/BotBrain');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Tools = invoke('GameServer/Bot/AI/BotAgentTools');
const Manager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Registry = invoke('GameServer/Bot/AI/BotToolRegistry');

async function main() {
    const dialogue = Protocol.messages('system', { playerMessage: 'Why that kind in particular?',
        bot: { name: 'MusicBot' }, conversation: { summary: 'Friends.', recentTurns: [
            { role: 'player', text: 'What music do you like?' }, { role: 'bot', text: 'Classical.' },
            { role: 'player', text: 'Why that kind in particular?' }
        ] }, contextFragments: [{ id: 'recent_dialogue', value: 'DUPLICATE' }] });
    assert.deepStrictEqual(dialogue.slice(2).map(row => [row.role, row.content]), [
        ['user', 'What music do you like?'], ['assistant', 'Classical.'], ['user', 'Why that kind in particular?']
    ]);
    assert(!dialogue[1].content.includes('Classical') && !dialogue[1].content.includes('DUPLICATE'));
    assert(!JSON.parse(dialogue[1].content).conversation.recentTurns);
    const oversized = Protocol.fitContext({ bot: { name: 'ActualBot', inventory: { items: Array.from({ length: 100 }, () => ({ id: 1, name: 'Long item '.repeat(100) })) } } }, 240);
    assert(Protocol.estimate(oversized) <= 240);
    assert.strictEqual(oversized.bot.name, 'ActualBot');
    const small = Protocol.fitMessages(dialogue, {}, 500);
    assert.strictEqual(small.at(-1).content, 'Why that kind in particular?');

    let mutations = 0;
    const rounds = [];
    const decisions = [
        { action: 'inspect_self', topic: 'inventory', reply: '' },
        { action: 'equip_candidate', itemId: 77, reply: 'Speculative reply' },
        { action: 'say', reply: 'Equipped the real item.' }
    ];
    const result = await Runner.run({ messages: dialogue, isRead: action => action === 'inspect_self',
        generate: async input => { rounds.push(structuredClone(input)); return { ...decisions[rounds.length - 1], usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }; },
        read: async () => ({ ok: true, rows: [{ objectId: 77, name: 'Tarbar' }] }),
        mutate: async decision => { mutations++; assert.strictEqual(decision.itemId, 77); return { applied: true, itemId: 77, reason: 'equipped' }; }
    });
    assert.strictEqual(mutations, 1);
    assert.strictEqual(rounds.length, 3);
    assert(rounds[1].messages.at(-1).content.includes('Tarbar'));
    assert(rounds[2].final && rounds[2].messages.at(-1).content.includes('serverActionResult'));
    assert.strictEqual(result.action, 'equip_candidate');
    assert.strictEqual(result.reply, 'Equipped the real item.');
    assert.strictEqual(result.usage.promptTokens, 300);

    let acknowledgements = 0, committed = 0;
    const lostAcknowledgement = await Runner.run({ messages: dialogue, isRead: () => false,
        generate: async () => {
            if (++acknowledgements === 2) throw new Error('provider unavailable after commit');
            return { action: 'equip_candidate', reply: 'Speculative success', usage: { promptTokens: 100, completionTokens: 10 } };
        }, mutate: async () => { committed++; return { applied: true, reason: 'equipped' }; } });
    assert.strictEqual(committed, 1);
    assert.strictEqual(lostAcknowledgement.mutation.result.reason, 'equipped');
    assert.strictEqual(lostAcknowledgement.reply, '', 'failed reflection must not reuse the speculative pre-action reply');
    const policyAction = await Runner.run({ messages: dialogue, isRead: () => false,
        generate: async ({ final }) => final ? { action: 'say', reply: 'Everyone is regrouping.' }
            : { action: 'follow_player', reply: 'I arrived.' },
        mutate: async () => ({ applied: true, outcome: 'pending', effect: 'approach_requested',
            executedDecision: { action: 'regroup_party', reply: '' } }) });
    assert.strictEqual(policyAction.action, 'regroup_party', 'record the actual action chosen by server party policy');
    assert.strictEqual(policyAction.reply, 'Everyone is regrouping.');
    let actorPresent = true, actorCalls = 0;
    const stale = await Runner.run({ messages: dialogue, alive: () => actorPresent, isRead: () => true,
        generate: async () => { actorCalls++; return { action: 'inspect_self', topic: 'inventory' }; },
        read: async () => { actorPresent = false; return { ok: true }; } });
    assert.strictEqual(stale.reason, 'actor_changed');
    assert.strictEqual(actorCalls, 1, 'an actor switch while reading must stop the turn');

    let reads = 0, calls = 0;
    const bounded = await Runner.run({ messages: dialogue, isRead: () => true,
        generate: async () => { calls++; return { action: 'inspect_self', topic: 'inventory' }; },
        read: async () => { reads++; return { ok: true }; } });
    assert(reads <= Runner.MAX_READS && calls <= Runner.MAX_ROUNDS);
    assert.strictEqual(bounded.ok, false, 'a model endlessly asking to inspect cannot create an unbounded loop');

    const actualItem = { fetchId: () => 77, fetchSelfId: () => 1870, fetchName: () => 'Coal', fetchAmount: () => 23, fetchEquipped: () => false };
    const inventory = await Knowledge.inspect({ topic: 'inventory', query: 'Coal' }, { session: { actor: { backpack: { fetchItems: () => [actualItem] } } } });
    assert.strictEqual(inventory.rows[0].objectId, 77);
    assert.strictEqual(inventory.rows[0].count, 23, 'unequipped non-consumable resources are discoverable');
    assert.strictEqual((await Knowledge.inspect({ topic: 'inventory' }, { session: { characterId: 10 } })).ok, false);
    const snapshot = await Knowledge.inspect({ topic: 'inventory', query: 'Coal' }, { session: {
        characterId: 10, updatedAt: 123, inventory: { 1870: { selfId: 1870, name: 'Coal', amount: 23 } }
    } });
    assert.strictEqual(snapshot.rows[0].count, 23);
    assert.strictEqual(snapshot.updatedAt, 123);
    assert.strictEqual(snapshot.source, 'persistent_inventory_snapshot');
    assert.strictEqual(snapshot.historyEvidence, false);
    assert.strictEqual((await Knowledge.inspect({ topic: 'relationship' }, { session: {}, publicChat: true })).reason, 'private_memory');
    const sources = Knowledge.lookup({ topic: 'item_sources', entityId: 1870 }, {
        itemDetail: () => ({ id: 1870, name: 'Coal', sources: { drops: [{ id: 120, name: 'Known Mob', level: 20,
            chancePercent: 12.5, expectedAmountPerKill: 0.2 }] }, rateProfile: { multiplier: 1 } })
    });
    assert.strictEqual(sources.rows[0].chancePercent, 12.5);
    assert(sources.observation.includes('not a live sighting'));
    let lookedUpId;
    const byName = Knowledge.lookup({ topic: 'item_sources', query: 'Coal' }, {
        listItems: () => ({ total: 2, items: [{ id: 1870, name: 'Coal' }, { id: 99, name: 'Coal Piece' }] }),
        itemDetail: id => { lookedUpId = id; return { id, name: 'Coal', sources: { drops: [] } }; }
    });
    assert(byName.ok && lookedUpId === 1870, 'one exact canonical name resolves to actual sources in one read');
    const ambiguous = Knowledge.lookup({ topic: 'item_sources', query: 'Coal' }, {
        listItems: () => ({ total: 2, items: [{ id: 98, name: 'Coal Dust' }, { id: 99, name: 'Coal Piece' }] })
    });
    assert.strictEqual(ambiguous.reason, 'ambiguous_item_name');
    assert.strictEqual(Knowledge.lookup({ topic: 'recipes', entityId: 10 }, { catalogue: () => ({ capabilities: () => ({ recipes: false }) }) }).reason, 'recipes_unavailable');

    let writes = 0;
    Registry.register({ name: 'dialogue_fixture_read', mutating: false, execute: () => ({ applied: true, reason: 'read' }) });
    Registry.register({ name: 'dialogue_fixture_write', execute: () => { writes++; return { applied: true, reason: 'write' }; } });
    const fixture = { actor: { fetchId: () => 333 } };
    const fixtureContext = { session: fixture, requestContext: { requestId: 'read-then-write' } };
    assert(Registry.execute({ ...fixtureContext, decision: { action: 'dialogue_fixture_read' } }).applied);
    assert(Registry.execute({ ...fixtureContext, decision: { action: 'dialogue_fixture_write', confidence: 1 } }).applied,
        'a read must not use the one mutation slot');
    assert(Registry.execute({ ...fixtureContext, decision: { action: 'dialogue_fixture_write', confidence: 1 } }).idempotent);
    assert.strictEqual(writes, 1);

    const old = { ai: options.default.AI, or: options.default.OpenRouter, execute: Tools.execute, tell: Manager.botTell, user: World.user };
    const actor = (id, name) => ({ fetchId: () => id, fetchName: () => name, fetchLevel: () => 20,
        fetchClassId: () => 0, fetchHp: () => 100, fetchMaxHp: () => 100, fetchKarma: () => 0,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchDestId: () => 0,
        fetchIsOnline: () => true, isDead: () => false, backpack: { fetchItems: () => [] } });
    const player = { accountId: 'player_dialogue_tools', actor: actor(901, 'Player') };
    const bot = { accountId: 'bot_dialogue_tools', actor: actor(902, 'Bot'), plan: 'following', partyCompanion: true, followPlayerSession: player };
    const requests = [], replies = [], executions = [];
    try {
        options.default.AI = undefined;
        options.default.OpenRouter = { enabled: true, apiKey: 'test', model: 'test/dialogue', strictSchema: false };
        World.user = { sessions: [player, bot] };
        Manager.botTell = (_bot, _player, text) => replies.push(text);
        Tools.execute = async (_session, decision) => {
            executions.push(decision.action);
            return decision.action === 'list_safe_loadouts' ? { applied: true, loadouts: [{ itemId: 77, name: 'Tarbar' }] }
                : { applied: true, reason: 'equipped', itemId: 77 };
        };
        Gateway.setTransport(async (_url, init) => {
            const body = JSON.parse(init.body); requests.push(body);
            const data = requests.length === 1 ? { action: 'get_actions', topic: 'equipment', reply: '', reason: 'inspect', confidence: 1 }
                : requests.length === 2 ? { action: 'equip_candidate', itemId: 77, reply: 'Not yet delivered', reason: 'upgrade', confidence: 1 }
                    : { action: 'say', reply: 'Now using Tarbar.', reason: 'confirmed', confidence: 1 };
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(data) } }],
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) };
        });
        assert(Brain.maybeThink(bot, 'player_chat', { available: false }, 'Equip an upgrade.', { playerSession: player,
            requestId: 'dialogue-tools', conversationTurn: { turnId: 'dialogue-tools', channel: 'client_tell' },
            assembledContext: { bot: { name: 'Bot', level: 20 }, fragments: [] } }));
        for (let i = 0; i < 100 && bot.brainInFlight; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.strictEqual(bot.brainInFlight, false);
        assert.deepStrictEqual(executions, ['list_safe_loadouts', 'equip_candidate'], 'receipt delivery must never execute a mutation again');
        assert.deepStrictEqual(replies, ['Now using Tarbar.'], 'speculative speech must not be delivered');
        const firstSchema = requests[0].response_format.json_schema.schema;
        assert(!firstSchema.properties.itemId && !firstSchema.properties.negotiationPrice, 'ordinary chat does not carry equipment or trading argument schemas');
        assert(requests[1].response_format.json_schema.schema.properties.itemId);
        assert.deepStrictEqual(requests[2].response_format.json_schema.schema.properties.action.enum, ['say']);
        assert(requests.every(request => request.max_tokens || request.max_completion_tokens));
        assert(Protocol.requestSize(requests[0].messages, requests[0].response_format) < 2400, 'small talk must not drag every action description into the prompt');
        assert.strictEqual(Budget.status(bot).promptTokens, 300, 'all rounds must be charged to the same turn');
        await bot.lastConversationWrite;
        replies.length = 0;
        Gateway.setTransport(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: {
            content: JSON.stringify({ action: 'none', reply: 'Must stay silent', reason: 'none', confidence: 1 })
        } }] }) }));
        Brain.maybeThink(bot, 'player_chat', { available: false }, 'No reply needed', { playerSession: player, requestId: 'silence' });
        for (let i = 0; i < 100 && bot.brainInFlight; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepStrictEqual(replies, [], 'none cannot deliver speculative or stray text');

        requests.length = 0;
        Tools.execute = async (_session, decision) => {
            assert.strictEqual(decision.action, 'propose_trade');
            bot.activeTrade = { id: 'opened-by-this-turn' };
            return { applied: true, reason: 'trade_opened' };
        };
        Gateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            const value = requests.length === 1 ? { action: 'get_actions', topic: 'trade', reply: '', reason: 'request', confidence: 1 }
                : requests.length === 2 ? { action: 'propose_trade', reply: 'Speculative', reason: 'request', confidence: 1 }
                    : { action: 'say', reply: 'Trade window is open.', reason: 'receipt', confidence: 1 };
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) };
        });
        Brain.maybeThink(bot, 'player_chat', { available: false }, 'Open a trade.', { playerSession: player, requestId: 'open-trade' });
        for (let i = 0; i < 100 && bot.brainInFlight; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepStrictEqual(replies, ['Trade window is open.'], 'opening a trade must not invalidate its own already-validated receipt');
        delete bot.activeTrade;

        replies.length = 0;
        requests.length = 0;
        let releaseReply;
        Gateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            await new Promise(resolve => { releaseReply = resolve; });
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: {
                content: JSON.stringify({ action: 'say', reply: 'Old character reply', reason: 'old_turn', confidence: 1 })
            } }] }) };
        });
        Brain.maybeThink(bot, 'player_chat', { available: false }, 'Stay here, do not follow me.', { playerSession: player, requestId: 'old-actor' });
        Brain.maybeThink(bot, 'player_chat', { available: false }, 'Queued old character question', { playerSession: player, requestId: 'old-actor-queued' });
        for (let i = 0; i < 100 && !releaseReply; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert(releaseReply);
        assert(requests[0].response_format.json_schema.schema.properties.action.enum.includes('stay_here'),
            'a direct movement order gets the small native action group immediately');
        assert(!requests[0].response_format.json_schema.schema.properties.action.enum.includes('quote_item'),
            'movement orders do not preload trading actions');
        const originalActor = player.actor;
        player.actor = actor(903, 'Replacement');
        releaseReply();
        for (let i = 0; i < 100 && bot.brainInFlight; i++) await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(replies, [], 'old hot replies cannot be delivered to a replacement character');
        assert.strictEqual(requests.length, 1, 'queued hot turns preserve the original actor identity');
        player.actor = originalActor;

        let partyDeliveries = 0;
        const oldRecipients = Manager.partyChatRecipients, oldPartySay = Manager.botPartySay;
        const packets = [];
        const recipient = { actor: player.actor, dataSendToMe: packet => packets.push(packet) };
        Manager.partyChatRecipients = () => [recipient];
        Manager.botPartySay = () => { partyDeliveries++; };
        try {
            old.tell.call(Manager, bot, recipient, 'Private reply', { channel: 'client_tell' });
            assert.strictEqual(partyDeliveries, 0, 'a companion cannot broadcast a private reply to its party');
            assert.strictEqual(packets.length, 1);
            old.tell.call(Manager, bot, recipient, 'Party reply', { channel: 'party_chat' });
            assert.strictEqual(partyDeliveries, 1);
        } finally { Manager.partyChatRecipients = oldRecipients; Manager.botPartySay = oldPartySay; }
    } finally {
        options.default.AI = old.ai; options.default.OpenRouter = old.or; Tools.execute = old.execute;
        Manager.botTell = old.tell; World.user = old.user; Gateway.resetTransport(); Budget.reset();
    }
    console.log('Dialogue history, bounded tools, catalogue truth and one-mutation delivery checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
