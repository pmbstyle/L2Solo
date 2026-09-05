const assert = require('assert');
require('../src/Global');
const Reactions = invoke('GameServer/Bot/AI/BotChatReactions');
const Budget = invoke('GameServer/Bot/AI/BotChatterBudget');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const Conversation = invoke('GameServer/Bot/AI/BotConversation');
const BotAI = invoke('GameServer/Bot/BotAI');
const Manager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const original = { now: Date.now, random: Math.random, user: World.user, visible: World.fetchVisibleRealPlayers,
    sessions: Manager.sessions, speak: Response.speak, info: console.info, config: { ...Config } };
let now = 1000000;
const packets = [];
function bot(id, x = 0, z = 0) {
    const actor = { fetchId: () => id, fetchName: () => `Bot${id}`, fetchLocX: () => x,
        fetchLocY: () => 0, fetchLocZ: () => z, fetchIsOnline: () => true, isDead: () => false };
    return { botSession: true, accountId: `bot_${id}`, actor, plan: 'resting',
        dataSendToOthers(packet) { packets.push(packet); } };
}
const player = { accountId: 'player', socket: { write() {} }, dataSendToMe(packet) { packets.push(packet); } };
function reset() {
    Reactions.reset(); Budget.reset(); GlobalChat.reset(); packets.length = 0;
    World.user = { sessions: [player] };
    World.fetchVisibleRealPlayers = () => World.user.sessions;
    Config.chatReactionsEnabled = true; Config.chatReactionChance = 1;
    Config.globalChatEnabled = true; Config.globalChatImportantChance = 1; Config.globalChatMinIntervalMs = 180000;
    now += 1000000;
}
function gear(source) {
    return TownChatter.say(source, BotAI, 'npc-gear-purchased',
        Speech.lines('town.npc-gear-purchased', { item: 'Sword of Revolution', seller: 'Graham' }), { now });
}
try {
    Date.now = () => now;
    Math.random = () => 0;
    console.info = () => {};
    Response.speak = (actor, data) => ({ id: actor.fetchId(), name: actor.fetchName(), ...data });
    reset();
    let first = bot(1), second = bot(2, 100), third = bot(3, 200);
    Manager.sessions = [first, second, third];
    assert(gear(first));
    assert.strictEqual(Reactions.snapshot(now).local, 1);
    assert(!Conversation.canStart(first, second, now + 1), 'native gossip must not overlap a reaction');
    assert(!Reactions.offerLocal(second, now + 1000), 'no instant scripted reply');
    assert(!Reactions.offerLocal(bot(4, 100), now + 3000), 'a late arrival did not hear the opener');
    assert(Reactions.offerLocal(second, now + 3000));
    assert(!Reactions.offerLocal(third, now + 3000), 'one reply, not a crowd answering together');
    assert(Reactions.offerLocal(first, now + 6000));
    assert(!Reactions.offerLocal(second, now + 9000), 'replies must not recursively create new exchanges');
    assert.strictEqual(packets.length, 3);
    assert.deepStrictEqual(packets.map(packet => packet.id), [1, 2, 1]);
    assert(packets[1].text.includes('Bot1'));
    assert(packets.every(packet => packet.kind === 0 && packet.text.length <= 120));
    assert(!Budget.canSend(third, 'victory', now + 60000), 'reply lines borrow from the following quiet period');
    assert(Budget.canSend(third, 'victory', now + 150000));

    for (const change of [
        source => { source.actor.isDead = () => true; },
        source => { source.aiActive = false; },
        source => { source.partyCompanion = true; },
        source => { source.actor.fetchIsOnline = () => false; },
        source => { source.actor.state = { fetchHits: () => true }; },
        source => { source.actor.fetchLocX = () => 5000; },
        source => { source.actor.fetchLocZ = () => 2000; }
    ]) {
        reset(); first = bot(1); second = bot(2, 100); Manager.sessions = [first, second];
        assert(gear(first)); change(first);
        assert(!Reactions.offerLocal(second, now + 3000), 'invalidated local scene must not deliver a stale response');
        assert.strictEqual(packets.length, 1);
    }
    reset(); first = bot(1); second = bot(2, 100); Manager.sessions = [first, second];
    assert(gear(first)); World.user.sessions = [];
    assert(!Reactions.offerLocal(second, now + 3000), 'no reply after the audience leaves');
    assert.strictEqual(Reactions.snapshot(now + Reactions.RESPONSE_WINDOW_MS).local, 0);
    reset(); first = bot(1); second = bot(2, 100); Manager.sessions = [first, second];
    gear(first); Reactions.cancel(first);
    assert(!Reactions.offerLocal(second, now + 3000), 'lifecycle cancellation releases pending scenes');

    reset();
    const cold = { characterId: 10, name: 'Aria', phase: 'cold', activity: 'dead', vitals: { hp: 0 } };
    const listener = { characterId: 11, name: 'Belen', phase: 'cold', activity: 'hunting', vitals: { hp: 100 } };
    assert(GlobalChat.maybeAnnounce(cold, [{ type: 'death' }], now));
    assert(!GlobalChat.maybeAnnounce(cold, [], now + 3000), 'the author cannot answer himself');
    assert(!GlobalChat.maybeAnnounce({ ...listener, phase: 'hot' }, [], now + 3000), 'stale cold state cannot speak for an activated bot');
    assert(GlobalChat.maybeAnnounce(listener, [], now + 3000), 'fresh ordinary cold work can supply a responder');
    for (let n = 12; n < 1012; n++) assert(!GlobalChat.maybeAnnounce({ ...listener, characterId: n }, [], now + 3000));
    assert(!GlobalChat.maybeAnnounce(cold, [], now + 6000), 'a dead opener must not be forced into a follow-up');
    assert(GlobalChat.maybeAnnounce({ ...cold, activity: 'resting', vitals: { hp: 100 } }, [], now + 12000));
    assert.strictEqual(packets.length, 3);
    assert.deepStrictEqual(packets.map(packet => packet.id), [10, 11, 10]);
    assert(packets.every(packet => packet.kind === 1));
    assert(!GlobalChat.maybeAmbient(bot(99), now + 180000), 'a three-line exchange must extend the global quiet period');
    assert(GlobalChat.maybeAmbient(bot(99), now + 540000));

    reset(); Config.chatReactionsEnabled = false;
    first = bot(1); second = bot(2); Manager.sessions = [first, second];
    gear(first);
    assert.deepStrictEqual(Reactions.snapshot(now), { global: false, local: 0 });
    assert(!Reactions.offerLocal(second, now + 3000));

    reset();
    for (let n = 0; n < 40; n++) {
        const source = bot(n * 2 + 1, n * 10000), neighbour = bot(n * 2 + 2, n * 10000 + 100);
        Manager.sessions = [source, neighbour];
        Reactions.openLocal(source, 'rest', now);
    }
    assert.strictEqual(Reactions.snapshot(now).local, Reactions.MAX_LOCAL_SCENES, 'scene memory is bounded regardless of population');
    assert.strictEqual(Reactions.snapshot(now + Reactions.RESPONSE_WINDOW_MS).local, 0);
    process.stdout.write('Bot reactive chat checks passed: local/global delivery, interruptions, limits and bounded memory.\n');
} finally {
    Date.now = original.now; Math.random = original.random; World.user = original.user;
    World.fetchVisibleRealPlayers = original.visible; Manager.sessions = original.sessions;
    Response.speak = original.speak; console.info = original.info; Object.assign(Config, original.config);
    Reactions.reset(); Budget.reset(); GlobalChat.reset();
}
