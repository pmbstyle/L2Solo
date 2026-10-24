const assert = require('node:assert/strict');
require('../src/Global');
const Party = invoke('GameServer/Bot/AI/BotDialogueParty');
const Brain = invoke('GameServer/Bot/AI/BotBrain');
const Remote = invoke('GameServer/Bot/AI/BotRemoteChat');
const Availability = invoke('GameServer/Bot/AI/BotAvailability');
const PersonaPolicy = invoke('GameServer/Bot/AI/PersonaPartyDecisionPolicy');
const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const MemoryPolicy = invoke('GameServer/Social/InteractionMemoryPolicy');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Tracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Events = invoke('GameServer/Bot/Population/BotLifeEvents');
const Store = invoke('GameServer/Bot/AI/BotConversationStore');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Summarizer = invoke('GameServer/Bot/AI/BotConversationSummarizer');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Manager = invoke('GameServer/Bot/BotManager');

async function main() {
    for (const text of ["I'm not, I'm trying to understand if we can party", 'maybe we can group',
        'can we party?', 'could you group with me?', 'wanna party?', 'join our group',
        'Can we form a party?', 'Are you up for a party?']) assert(Party.isRequest(text), text);
    for (const text of ['Can you join my clan?', 'How do I invite you to my clan?',
        'I am already in a party, can you join my clan?', 'I am in a party and can you join my clan?']) assert(!Party.isRequest(text), text);
    for (const text of ['Who can I group with?', 'Who can I join for hunting?', 'Can I join any other party?']) {
        assert(Party.isCandidateRequest(text), text);
        assert(!Party.isRequest(text), text);
    }
    assert(!Party.isRequest('Can you join my clan? I already have a party.'));
    assert(Party.isRequest('Can you join my clan? Can we group too?'));
    assert(!Party.shouldCheck('Can you join my clan? I already have a party.', {
        partyIntent: 'none', reply: 'I can join your clan. I am happy with my party.'
    }));
    for (const text of ['Come here so I can invite you to my party.', 'Can you come to me so we can group?']) {
        assert(Party.isArrivalRequest(text), text);
    }
    for (const text of ["Don't come here", 'We can party when you come here', 'What if you come here?']) {
        assert(!Party.isArrivalRequest(text), text);
    }
    for (const text of ['Can you join my party with the other players?', 'I need someone to party with. Can you join me?']) {
        assert(!Party.isCandidateRequest(text), text);
        assert(Party.isRequest(text), text);
    }
    for (const text of ['find a better hunting spot for this party', 'are you in a party?',
        'who can join our group?', 'the party is in town', 'why did you join that party yesterday?']) assert(!Party.isRequest(text), text);
    const actor = (id, name) => ({ fetchId: () => id, fetchName: () => name, fetchLevel: () => 52,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchKarma: () => 0, fetchClanId: () => 0, fetchLocX: () => 0, fetchLocY: () => 0,
        fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false });
    const player = { actor: actor(72001, 'Player'), dataSendToMe() {} };
    const state = { characterId: 72002, name: 'SEMMANA', level: 52, activity: 'hunting',
        loc: { locX: 0, locY: 0, locZ: 0 }, vitals: { hp: 100, maxHp: 100 }, inventory: {}, stats: {} };
    Memory.accept(MemoryPolicy.empty(state.characterId));
    const saved = { ai: options.default.AI, router: options.default.OpenRouter, policy: PersonaPolicy.evaluate,
        load: Social.load, record: Social.recordEvent, summarize: Summarizer.summarize,
        recent: Events.recentForBot, root: Tracing.withRootObservation,
        observation: Tracing.withObservation, cached: LifeState.cachedState,
        activate: Population.requestActivation, find: Manager.findSessionByName };
    let loaded = false, accept = false, changeDuringInference = false, calls = 0, action = 'say', partyIntent = 'none';
    let modelSpeech = "Absolutely, I'll join your party!";
    let latest = state;
    try {
        options.default.AI = undefined;
        options.default.OpenRouter = { enabled: true, apiKey: 'fixture', model: 'fixture/party', strictSchema: false };
        Store.resetMemory();
        Social.recordEvent = async () => null;
        Summarizer.summarize = async () => ({ ok: false, reason: 'isolated_party_fixture' });
        Social.load = async () => { loaded = true; return Social.peekSnapshot(player, state); };
        PersonaPolicy.evaluate = () => {
            assert(loaded, 'membership evaluation must follow the awaited relationship load');
            return { accept, reason: accept ? 'available' : 'prefers_solo',
                reasonText: accept ? 'available' : 'prefers a solo run for now' };
        };
        Events.recentForBot = async () => [];
        Tracing.withRootObservation = (_name, _input, _meta, work) => work(null);
        Tracing.withObservation = (_name, _input, _meta, work) => work(null);
        LifeState.cachedState = id => id === state.characterId ? latest : saved.cached(id);
        Gateway.setTransport(async () => {
            calls++;
            if (changeDuringInference) latest = { ...state, vitals: { hp: 0, maxHp: 100 } };
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
                action, partyIntent, reply: modelSpeech, reason: 'model_promise', confidence: 1
            }) } }] }) };
        });
        const refused = await Remote.replyForState(player, state, "I'm not, I'm trying to understand if we can party");
        assert.equal(refused.reason, 'party_policy:prefers_solo');
        assert.match(refused.reply, /cannot join right now/);
        assert(!refused.reply.includes("I'll join"));
        for (const text of ['Can we form a party?', 'Are you up for a party?', 'Would tagging along make sense?']) {
            assert.equal((await Remote.replyForState(player, state, text)).reason, 'party_policy:prefers_solo', text);
        }
        for (const text of ['Can you join my party with the other players?', 'I need someone to party with. Can you join me?']) {
            partyIntent = 'membership';
            assert.equal((await Remote.replyForState(player, state, text)).reason, 'party_policy:prefers_solo', text);
        }
        modelSpeech = 'You can invite HealerOne; I can check which other players are available.';
        assert.equal((await Remote.replyForState(player, state, 'Who can join our party?')).reason,
            'party_policy:prefers_solo', 'semantic membership intent cannot bypass policy just because candidates are mentioned');
        partyIntent = 'none';
        for (const text of ['Can you join my clan?', 'How do I invite you to my clan?',
            'I am already in a party, can you join my clan?', 'I am in a party and can you join my clan?',
            'Can you join my clan? I already have a party.']) {
            for (const speech of ['Send me an invite to your clan.', 'Sure, send me an invite.', "Sure, I'll accept your invite."]) {
                modelSpeech = speech;
                assert.equal((await Remote.replyForState(player, state, text)).reply, modelSpeech,
                    'a short clan reply inherits the invitation target, not unrelated current party membership');
            }
        }
        for (const text of ['Who can I group with?', 'Who can I join for hunting?', 'Can I join any other party?']) {
            modelSpeech = 'You could ask HealerOne about her group.';
            const candidate = await Remote.replyForState(player, state, text);
            assert.equal(candidate.reply, modelSpeech, 'candidate advice must not become a membership refusal');
            assert.equal(candidate.reason, 'model_promise');
        }
        partyIntent = 'membership'; modelSpeech = 'Sounds good!';
        for (const text of ['Would having you with us make sense?',
            'Can you join my clan? Would having you in our party make sense too?',
            'Could you join my clan? Are we a good match for a party?']) {
            assert.equal((await Remote.replyForState(player, state, text)).reason,
                'party_policy:prefers_solo', 'semantic membership intent takes precedence over unrelated clan context');
        }
        partyIntent = 'none'; modelSpeech = "Absolutely, I'll join your party!";
        for (const [text, speech] of [
            ['How do we improve this party?', 'We can make the party stronger by upgrading our weapons.'],
            ['What can you craft for our party?', 'I can make a sword for your party.'],
            ['Are you happy with your group?', 'I am happy with my party.']
        ]) {
            assert(!Party.shouldCheck(text, { action: 'say', partyIntent: 'none', reply: speech }));
            modelSpeech = speech;
            assert.equal((await Remote.replyForState(player, state, text)).reply, speech,
                'ordinary advice and crafting must not become membership refusals');
        }
        modelSpeech = "Absolutely, I'll join your party!";
        accept = true;
        const willing = await Remote.replyForState(player, state, 'maybe we can group');
        assert.equal(willing.reason, 'party_policy:available');
        assert.equal(willing.reply, Party.reply({ available: true }));
        const level = await Remote.replyForState(player, state, 'What is your level, maybe we can group?');
        assert.match(level.reply, /level 52/, 'the membership policy must preserve the other factual question');
        action = 'come_to_player';
        const noArrival = await Remote.replyForState(player, state, 'can we party?');
        assert.equal(noArrival.action, 'say', 'a membership question must not authorize an unsolicited arrival');
        let activations = 0;
        const hotBot = { actor: actor(state.characterId, state.name) };
        Population.requestActivation = async () => { activations++; return { ok: true }; };
        Manager.findSessionByName = name => String(name).toLowerCase() === state.name.toLowerCase() ? hotBot : null;
        for (const text of ['Come here so I can invite you to my party.', 'Can you come to me so we can group?']) {
            partyIntent = 'membership';
            const arrival = await Remote.replyForState(player, state, text);
            assert.equal(arrival.action, 'come_to_player', text);
            assert.equal(arrival.actionResult.ok, true);
            assert(!/join your party/i.test(arrival.reply), 'an authorized arrival must not promise group admission');
        }
        assert.equal(activations, 2, 'both explicit movement requests must reach native activation');
        partyIntent = 'none';
        action = 'say';
        changeDuringInference = true;
        const died = await Remote.replyForState(player, state, 'can we party?');
        assert.equal(died.reason, 'party_policy:bot_dead', 'delivery must recheck the current state, not the original snapshot');
        assert.match(died.reply, /died/);
        assert.equal(Availability.evaluateState(player, latest).reason, 'bot_dead', 'zero HP is not one HP');
        assert.equal(Availability.evaluateState(player, { ...state, party: { partyId: 'native-party' } }).reason, 'already_grouped');
        const hot = { actor: actor(state.characterId, 'HotBot') };
        accept = false;
        const hotReply = Brain.applyPartyPolicy(hot, { action: 'say', reply: "I'll join", confidence: 1 },
            { playerSession: player }, 'maybe we can group');
        assert.equal(hotReply.reason, 'party_policy:prefers_solo');
        const indirect = Brain.applyPartyPolicy(hot, { action: 'say', partyIntent: 'membership', reply: 'Sounds good!', confidence: 1 },
            { playerSession: player }, 'Would having you with us make sense?');
        assert.equal(indirect.reason, 'party_policy:prefers_solo', 'the hot path must honor semantic membership intent too');
        const mixed = Brain.applyPartyPolicy(hot, { action: 'follow_player', partyIntent: 'membership', reply: modelSpeech },
            { playerSession: player }, 'Come here so I can invite you to my party.');
        assert.equal(mixed.action, 'follow_player', 'a single-bot approach must not become a whole-party regroup');
        const clan = Brain.applyPartyPolicy(hot, { action: 'say', partyIntent: 'none', reply: 'Send me an invite to your clan.' },
            { playerSession: player }, 'Can you join my clan?');
        assert.equal(clan.reply, 'Send me an invite to your clan.');
        assert.equal(calls, 37);
        console.log('Dialogue party consistency regressions passed');
    } finally {
        options.default.AI = saved.ai; options.default.OpenRouter = saved.router;
        PersonaPolicy.evaluate = saved.policy; Social.load = saved.load; Events.recentForBot = saved.recent;
        Social.recordEvent = saved.record; Summarizer.summarize = saved.summarize;
        Tracing.withRootObservation = saved.root; Tracing.withObservation = saved.observation;
        LifeState.cachedState = saved.cached; Gateway.resetTransport(); Budget.reset(); Memory.forget(state.characterId);
        Population.requestActivation = saved.activate; Manager.findSessionByName = saved.find;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
