const assert = require('assert');
require('../src/Global');
const Chat = invoke('GameServer/Bot/AI/ClanDialogueService');
const Clan = invoke('GameServer/Clan/ClanService');
const Manager = invoke('GameServer/Bot/BotManager');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Speak = invoke('GameServer/Network/Request/Speak');
const SendPacket = invoke('Packet/Send');
const Response = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Router = invoke('GameServer/Bot/AI/PartyLLMRouter');
const saved = { ai: options.default.AI, or: options.default.OpenRouter, find: Clan.findById,
    sessions: Manager.sessions, cached: Life.cachedState, speak: Response.speak,
    user: World.user, log: Config.devLogPlayerChat, router: Router.enabled };
let nextClan = 7000;
let fixture;
const requests = [];
let respond;
function member(id, name, clanId, bot = false) {
    const inbox = [];
    return { inbox, accountId: bot ? `bot_${id}` : `player_${id}`, socket: { write() {} },
        actor: { fetchId: () => id, fetchName: () => name, fetchClanId: () => clanId,
            fetchIsOnline: () => true, fetchDestId: () => 0, fetchClassId: () => 15, fetchLevel: () => 40,
            fetchLocX: () => 90000, fetchLocY: () => 90000, fetchLocZ: () => 0, isDead: () => false },
        dataSendToMe: packet => inbox.push(packet),
        dataSendToMeAndOthers() { throw new Error('clan chat leaked to local'); }
    };
}
function setup() {
    const id = nextClan++;
    const player = member(101, 'Player', id);
    const other = member(102, 'Friend', id);
    const hot = member(201, 'Arina', id, true);
    const cold = { characterId: 202, name: 'Arinor', phase: 'cold', level: 40, classId: 15,
        activity: 'hunting', stats: { clanId: 99999, generatedIndex: 2 } };
    const outsider = member(301, 'Outsider', id + 100, true);
    const stranger = member(302, 'Stranger', id + 100);
    const service = member(203, 'Service', id, true); service.staticService = true;
    const clan = { id, name: 'TestClan', level: 3, leaderId: 101,
        members: [player, other, hot, service].map(s => ({ id: s.actor.fetchId(), name: s.actor.fetchName() }))
            .concat([{ id: 202, name: 'Arinor' }]) };
    fixture = { id, player, other, hot, cold, outsider, stranger, clan };
    Clan.findById = clanId => Number(clanId) === id ? clan : null;
    Life.cachedState = botId => Number(botId) === 202 ? cold : null;
    Manager.sessions = [hot, outsider, service];
    World.user = { sessions: [player, other, hot, outsider, stranger, service] };
    requests.length = 0;
    respond = async request => request.response_format.json_schema.name === 'clan_chat_route'
        ? { route: 'bot', botId: 202, intent: 'conversation', confidence: 0.99, reason: 'addressed clanmate' }
        : { action: 'say', reply: 'Good to hear from you.' };
    return fixture;
}
function send(text, player = fixture.player) {
    return Chat.handlePlayerSpeak(player, { kind: 4, text });
}
async function spinUntil(test) {
    for (let i = 0; i < 100 && !test(); i++) await new Promise(resolve => setImmediate(resolve));
    assert(test(), 'pending request must reach the provider');
}
async function main() {
    try {
        options.default.AI = undefined;
        options.default.OpenRouter = { enabled: true, apiKey: 'clan-test', model: 'test/main', partyRouterModel: 'test/router' };
        Config.devLogPlayerChat = false;
        Response.speak = (actor, data) => ({ id: actor.fetchId(), name: actor.fetchName(), ...data });
        Gateway.setTransport(async (_url, init) => {
            const request = JSON.parse(init.body);
            assert.strictEqual(request.tools, undefined, 'neither routing nor replies may advertise tools');
            requests.push(request);
            const data = await respond(request);
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(data) } }] }) };
        });
        let f = setup();
        assert.deepStrictEqual(Chat.candidatesFor(f.id, f.player).map(entry => entry.id), [201, 202],
            'only clan bots, including cold members with stale stats, excluding service bots');
        f.player.partyDialogueState = { recentTurns: [{ text: 'private-party-secret' }] };
        f.player.botDialogueResponderId = 301;
        const packet = new SendPacket(0x38).writeS('Who feels like talking?').writeD(4).fetchBuffer();
        const result = await Speak(f.player, packet);
        assert.strictEqual(result.botId, 202);
        assert.deepStrictEqual(requests.map(r => r.model), ['test/router', 'test/main']);
        assert.strictEqual(f.player.inbox.length, 2, 'native ingress broadcasts player text and one bot reply');
        assert.deepStrictEqual(f.other.inbox, f.player.inbox);
        assert.strictEqual(f.player.inbox[1].kind, 4);
        assert.strictEqual(f.stranger.inbox.length, 0);
        assert.strictEqual(f.outsider.inbox.length, 0);
        assert.strictEqual(f.player.botDialogueResponderId, 301, 'clan ownership is separate from party/tells');
        assert(!JSON.stringify(requests).includes('private-party-secret'));
        assert.strictEqual(f.cold.phase, 'cold', 'chat never activates a background bot');
        assert.deepStrictEqual(requests[0].response_format.json_schema.schema.properties.route.enum, ['bot', 'clan', 'clarify', 'none']);

        requests.length = 0;
        await send('yes, tell me more');
        assert.strictEqual(requests.length, 1, 'continuation reuses its delivered responder');
        let payload = JSON.parse(requests[0].messages[1].content);
        assert.strictEqual(payload.bot.id, 202);
        assert(payload.recentClanTurns.some(turn => turn.text === result.reply));
        requests.length = 0;
        await send('Arina, hello');
        assert.strictEqual(requests.length, 1, 'explicit names bypass the LLM router');
        assert.strictEqual(JSON.parse(requests[0].messages[1].content).bot.id, 201);

        f = setup();
        await send('healer, hello');
        assert.strictEqual(requests[0].model, 'test/router', 'ambiguous roles go to routing');
        f = setup();
        f.hot.partyRole = 'tank';
        await send('tank, hello');
        assert.deepStrictEqual(requests.map(r => r.model), ['test/main']);
        assert.strictEqual(JSON.parse(requests[0].messages[1].content).bot.id, 201);

        f = setup();
        respond = async () => ({ route: 'clarify', botId: null, intent: 'clarify', confidence: 1, reason: 'ambiguous name' });
        const clarification = await send('Arin, hello');
        assert.strictEqual(clarification.reply, 'Which one do you mean: Arina or Arinor?');
        assert.strictEqual(requests.length, 1, 'clarification never enters the main model');
        f = setup();
        respond = async () => ({ route: 'none', botId: null, intent: 'none', confidence: 1, reason: 'no reply needed' });
        assert.strictEqual((await send('...')).delivered, false);
        assert.strictEqual(f.player.inbox.length, 0);
        f = setup();
        respond = async r => r.model === 'test/router'
            ? { route: 'clan', botId: null, intent: 'greeting', confidence: 1, reason: 'whole clan' }
            : { action: 'say', reply: 'Hello!' };
        await send('Hello clan!');
        assert.strictEqual(f.player.inbox.length, 1, 'whole-clan routing picks one spokesperson');

        f = setup();
        f.player.actor.fetchDestId = () => 202;
        await send('How are things?');
        assert.deepStrictEqual(requests.map(r => r.model), ['test/main'], 'selected clanmate routes directly');
        requests.length = 0;
        await send('Arina, did you hear us?', f.other);
        payload = JSON.parse(requests[0].messages[1].content);
        assert(payload.recentClanTurns.some(turn => turn.name === 'Player'), 'clanmates share public history');
        assert.strictEqual(payload.player.name, 'Friend');
        f = setup();
        await send('Arina, new clan here');
        payload = JSON.parse(requests[0].messages[1].content);
        assert.strictEqual(payload.recentClanTurns.length, 1, 'another clan cannot inherit previous clan history');
        requests.length = 0;
        await send('Arina, hello', f.stranger);
        await send('Arina, hello', f.hot);
        assert.strictEqual(requests.length, 0, 'outsiders and bots cannot initiate model dialogue');

        f = setup();
        respond = async () => ({ route: 'bot', botId: 99999, intent: 'conversation', confidence: 1, reason: 'bad id' });
        assert.strictEqual((await send('Who is around?')).clarification, true);
        assert.strictEqual(requests.length, 1, 'invalid model ID never reaches the main model');

        f = setup();
        const gatewayRequest = Gateway.request;
        try {
            Gateway.request = async () => { throw new Error('test provider failure'); };
            assert.strictEqual((await send('Arina, hello')).reason, 'chat_error');
            assert.strictEqual(Budget.globalStatus().inFlight, 0, 'failed calls release admission');
        } finally { Gateway.request = gatewayRequest; }
        assert.strictEqual((await send('Arina, try again')).delivered, true, 'failure cannot poison the queue');

        f = setup();
        let release;
        respond = async r => {
            if (r.model === 'test/router') {
                await new Promise(resolve => { release = resolve; });
                return { route: 'bot', botId: 202, intent: 'conversation', confidence: 1, reason: 'clanmate' };
            }
            return { action: 'say', reply: 'First answer.' };
        };
        const first = send('Who is around?');
        await spinUntil(() => release);
        const second = send('yes, continue');
        assert.strictEqual(requests.length, 1, 'second turn cannot overtake the pending router');
        release();
        await Promise.all([first, second]);
        assert.deepStrictEqual(requests.map(r => r.model), ['test/router', 'test/main', 'test/main']);
        payload = JSON.parse(requests[2].messages[1].content);
        assert.strictEqual(payload.bot.id, 202);
        assert(payload.recentClanTurns.some(turn => turn.role === 'bot' && turn.text === 'First answer.'));

        f = setup();
        respond = async () => { f.clan.members = f.clan.members.filter(m => m.id !== 201); return { action: 'say', reply: 'Too late.' }; };
        assert.strictEqual((await send('Arina, hello')).reason, 'speaker_unavailable');
        assert.strictEqual(f.player.inbox.length, 0, 'removed bot cannot deliver delayed reply');
        f = setup();
        respond = async () => { f.player.actor.fetchClanId = () => 0; return { action: 'say', reply: 'Too late.' }; };
        assert.strictEqual((await send('Arina, hello')).reason, 'membership_changed');
        assert.strictEqual(f.other.inbox.length, 0, 'departed sender cancels reply');
        f = setup();
        respond = async r => { f.clan.members = f.clan.members.filter(m => m.id !== 202);
            return { route: 'bot', botId: 202, intent: 'conversation', confidence: 1, reason: 'clanmate' }; };
        assert.strictEqual((await send('Who is there?')).reason, 'speaker_unavailable');
        assert.strictEqual(requests.length, 1, 'membership rechecked after router');

        f = setup();
        const originalRequest = Gateway.request;
        try {
            Gateway.request = async () => ({ ok: true, data: { action: 'come_to_player', reply: 'Moving now.' } });
            assert.strictEqual((await send('Arina, come here')).delivered, false);
            assert.strictEqual(f.player.inbox.length, 0, 'unsupported model actions never execute or announce');
        } finally { Gateway.request = originalRequest; }
        f = setup();
        Router.enabled = () => false;
        await send('Hello clan');
        assert.strictEqual(requests.length, 1, 'missing router model uses a single spokesperson');
        Router.enabled = saved.router;
        options.default.OpenRouter.enabled = false;
        requests.length = 0;
        await send('Arina, hello');
        assert.strictEqual(requests.length, 0, 'disabled LLM does not call the provider');
        options.default.OpenRouter.enabled = true;

        f = setup();
        release = null;
        respond = async () => { await new Promise(resolve => { release = resolve; }); return { action: 'none', reply: '' }; };
        const pending = Array.from({ length: Chat.MAX_PENDING }, () => send('Arina, hello'));
        await spinUntil(() => release);
        assert.strictEqual((await send('Arina, overflow')).reason, 'busy');
        respond = async () => ({ action: 'none', reply: '' });
        release();
        await Promise.all(pending);
        assert.strictEqual(requests.length, Chat.MAX_PENDING);
        assert.strictEqual(Budget.globalStatus().inFlight, 0);
        console.log('Clan dialogue routing, packet delivery, isolation, queue, and no-tools checks passed');
    } finally {
        options.default.AI = saved.ai; options.default.OpenRouter = saved.or;
        Clan.findById = saved.find; Manager.sessions = saved.sessions; Life.cachedState = saved.cached;
        Response.speak = saved.speak; World.user = saved.user; Config.devLogPlayerChat = saved.log;
        Router.enabled = saved.router; Gateway.resetTransport();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
