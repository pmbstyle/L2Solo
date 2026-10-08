const assert = require('assert');
require('./helpers/databaseIsolation');
require('../src/Global');
const Budget = invoke('GameServer/Bot/AI/BotChatterBudget');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const BotAI = invoke('GameServer/Bot/BotAI');
const BotManager = invoke('GameServer/Bot/BotManager');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const World = invoke('GameServer/World/World');

// Native ActorModel/World publication follows test_n62_visibility_index.
// This isolated fixture creates no database rows, cold claims or World timers.
const ActorModel = invoke('GameServer/Model/Actor');
const publishedSessions = new Set();
let fixtureWorld;
function clearPublishedSessions() {
    // Disconnect the whole old scene before removing its registrations: no
    // still-connected peer should receive an unrelated clan UI update here.
    for (const session of publishedSessions) session.actor.setIsOnline(false);
    for (const session of publishedSessions) World.removeUser(session);
    publishedSessions.clear();
}
function publishSessions(sessions) {
    clearPublishedSessions();
    if (!fixtureWorld) {
        fixtureWorld = { sessions: [], revision: 0 };
        World.user = fixtureWorld;
    }
    for (const session of sessions) {
        session.actor.session = session;
        World.insertUser(session);
        session.actor.setIsOnline(true);
        publishedSessions.add(session);
    }
}
function presenceSession(characterId, accountId, receive, clanId = 0, locX = 0) {
    const session = { accountId, fetchAccountId() { return this.accountId; },
        socket: { write() {}, destroy() {} }, dataSendToMe: receive,
        dataSendToMeAndOthers() {}, dataSendToOthers() {} };
    session.actor = new ActorModel({ id: characterId, name: accountId, username: accountId,
        title: '', level: 20, classId: 0, clanId, clanPrivileges: 0,
        locX, locY: 0, locZ: 0, hp: 100, maxHp: 100, isOnline: false });
    session.actor.session = session;
    return session;
}

const Response = invoke('GameServer/Network/Response');

function bot(id, x = 0) {
    return { plan: 'resting', actor: { fetchId: () => id, fetchName: () => `Bot${id}`,
        fetchLocX: () => x, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false } };
}
const original = { user: World.user, sessions: World.user?.sessions, speak: Response.speak,
    random: Math.random, info: console.info, say: BotManager.botSay,
    timeout: global.setTimeout, config: { ...Config } };
try {
    publishSessions([]);
    Config.globalChatEnabled = true;
    Config.globalChatMinIntervalMs = 180000;
    Config.globalChatImportantChance = 1;
    Budget.reset();
    GlobalChat.reset();
    Math.random = () => 0;
    console.info = () => {};
    const first = bot(1);
    assert(Budget.canSend(first, 'rest', 0));
    Budget.record(first, 'rest', 0);
    assert(!Budget.canSend(bot(2, 100), 'gear', 1000), 'nearby speakers share a local limit');
    assert(Budget.canSend(bot(3, 10000), 'gear', 1000), 'distant towns have independent chatter');
    assert(!Budget.canSend(bot(2, 100), 'rest', 60000), 'same subject cannot echo across nearby bots');
    assert(Budget.canSend(bot(2, 100), 'gear', 60000));
    assert(!Budget.canSend(first, 'gear', 60000), 'one speaker cannot monopolize local chat');
    assert(Budget.canSend(first, 'rest', 300000), 'history expires');

    Budget.reset();
    const local = [];
    BotManager.botSay = (_session, text) => local.push(text);
    BotAI.say(first, 'Need a breather.', { ambient: true, key: 'rest' });
    BotAI.say(first, 'Another status.', { ambient: true, key: 'target' });
    BotAI.say(first, 'Watch out!');
    assert.strictEqual(local.length, 2, 'ambient chatter remains throttled');
    assert.strictEqual(local[1], 'Watch out!', 'urgent and direct speech bypass ambient limits unchanged');

    // Exercise the real scheduled conversation delivery without waiting on
    // wall time. Moving away after the opener must cancel both later lines.
    Budget.reset();
    const timers = [];
    global.setTimeout = (callback) => { timers.push(callback); return 1; };
    const second = bot(2, 100);
    assert(BotManager.triggerConversation(first, second));
    const afterOpener = local.length;
    second.actor.fetchLocX = () => 10000;
    timers.forEach(callback => callback());
    assert.strictEqual(local.length, afterOpener);
    assert.strictEqual(first.inConversation, false);
    assert.strictEqual(second.inConversation, false);

    const packets = [];
    // The original audience had no actor ID; this is an isolated native actor
    // in the same explicit 8000000+ fixture namespace as the visibility test.
    publishSessions([presenceSession(8000001, 'player', packet => packets.push(packet))]);
    Response.speak = (actor, packet) => ({ id: actor.fetchId(), ...packet });
    const state = { characterId: 5, name: 'Cold', spotId: '24_14' };
    assert(!GlobalChat.maybeAnnounce(state, [{ type: 'hunt', weight: 4, meta: { wins: 7 } }], 0));
    assert(!GlobalChat.maybeAnnounce(state, [{ type: 'party' }], 0));
    assert(GlobalChat.maybeAnnounce(state, [{ type: 'death' }], 0));
    assert(!packets[0].text.includes('24_14'), 'internal spot identifiers must not reach chat');
    assert(!GlobalChat.maybeAmbient(bot(6), 1), 'hot and cold chatter share one global limit');
    assert(!GlobalChat.maybeAnnounce({ ...state, characterId: 7 }, [{ type: 'death' }], 180000),
        'a new speaker cannot bypass the death-topic cooldown');
    assert(GlobalChat.maybeAmbient(bot(6), 180000));
    assert(!GlobalChat.maybeAmbient(bot(6), 360000), 'global speakers need their own cooldown');
    clearPublishedSessions();
    assert(!GlobalChat.maybeAmbient(bot(8), 360000));
    publishSessions(original.sessions || []);

    GlobalChat.reset();
    const sample = [];
    publishSessions([presenceSession(8000001, 'player', packet => sample.push(packet))]);
    for (let time = 0; time < 30 * 60000; time += 1000) {
        // A busy population repeatedly offers both cold events and hot
        // chatter; increasing its size must not increase the output rate.
        for (let n = 0; n < 100; n++) {
            GlobalChat.maybeAnnounce({ ...state, characterId: 1000 + n }, [{ type: 'death' }], time);
            GlobalChat.maybeAmbient(bot(2000 + n), time);
        }
    }
    assert(sample.length <= Math.ceil(30 * 60000 / Config.globalChatMinIntervalMs));
    assert.strictEqual(sample.filter(packet => packet.id < 2000).length, 2,
        'at most two death reactions in a thirty-minute window');
    process.stdout.write(`Ambient chat stress check: ${sample.length} global lines in 30 simulated minutes, 2 death reactions.\n`);

    GlobalChat.reset(); Budget.reset(); sample.length = 0;
    Object.assign(Config, original.config);
    const alive = { characterId: 3000, name: 'Walker', phase: 'cold', activity: 'resting', vitals: { hp: 100 } };
    for (const change of [
        { phase: 'hot' }, { phase: 'offline' }, { activity: 'dead' },
        { vitals: { hp: 0 } }, { stats: { travel: { destination: 'town' } } }
    ]) assert(!GlobalChat.maybeAnnounce({ ...alive, ...change }, [], 0), 'only available cold bots may start a conversation');
    Config.globalChatChance = 0;
    assert(!GlobalChat.maybeAnnounce(alive, [], 0), 'ambient chance can disable cold openers');
    Config.globalChatChance = original.config.globalChatChance;
    clearPublishedSessions();
    assert(!GlobalChat.maybeAnnounce(alive, [], 0), 'cold openers need a real audience');
    publishSessions([presenceSession(8000001, 'player', packet => sample.push(packet))]);
    Config.globalChatEnabled = false;
    assert(!GlobalChat.maybeAnnounce(alive, [], 0));
    Config.globalChatEnabled = true;
    // No deaths and no hot AI ticks: the ordinary cold commit path alone
    // must keep a large world's chat alive, while retaining a shared cap.
    for (let time = 0; time < 30 * 60000; time += 5000) {
        for (let n = 0; n < 1700; n++) {
            GlobalChat.maybeAnnounce({ ...alive, characterId: 3000 + n, name: `Walker${n}` }, [], time);
        }
    }
    assert(sample.length >= 30, 'ambient chat must work without hot bots or death events');
    assert(sample.length <= Math.ceil(30 * 60000 / Config.globalChatMinIntervalMs) + 2, 'cold openers and replies share one traffic cap');
    assert(new Set(sample.map(packet => packet.id)).size >= 10, 'the same pair must not monopolize the channel');
    process.stdout.write(`Cold-only ambient check: ${sample.length} global lines in 30 simulated minutes, 1,700 bots, no death events.\n`);
} finally {
    clearPublishedSessions();
    World.user = original.user;
    Response.speak = original.speak;
    Math.random = original.random;
    console.info = original.info;
    BotManager.botSay = original.say;
    global.setTimeout = original.timeout;
    Object.assign(Config, original.config);
    Budget.reset();
    GlobalChat.reset();
}
console.log('Ambient chat budget and delivery checks passed');
