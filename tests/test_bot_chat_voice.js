const assert = require('assert');
require('./helpers/databaseIsolation');
require('../src/Global');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const Persona = invoke('GameServer/Bot/AI/BotPersona');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const Reactions = invoke('GameServer/Bot/AI/BotChatReactions');
const Chat = invoke('GameServer/Bot/Population/BotGlobalChat');
const Conversation = invoke('GameServer/Bot/AI/BotConversation');
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
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Database = invoke('Database');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const original = { execute: Database.execute, random: Math.random,
    line: Voice.line, user: World.user, speak: Response.speak, info: console.info, config: { ...Config } };
function character(characterId, traits = {}, primaryDrive = 'social') {
    return { characterId, name: `Person${characterId}`, phase: 'cold', activity: 'resting', vitals: { hp: 100 },
        persona: { primaryDrive, traits: { ...Object.fromEntries(Persona.TRAITS.map(key => [key, 0.5])), ...traits } } };
}
try {
    Database.execute = () => { throw new Error('Chat voice must not query the database'); };
    console.info = () => {};
    Voice.reset();
    const cold = { characterId: 123, stats: { generatedIndex: 456 } };
    const hot = { actor: { fetchId: () => 123 }, coldLifeState: cold };
    assert.strictEqual(Voice.profile(cold), null, 'a bot without a stored persona is not given a generated one');
    const saved = Persona.generate(cold);
    Persona.useRowSource((id) => (id === 123 ? Persona.tableRow(saved) : null));
    assert.deepStrictEqual(Voice.profile(cold).traits, saved.traits, 'the stored persona is the voice');
    assert.strictEqual(Voice.profile(cold), Voice.profile(hot), 'activation keeps the same stored persona');
    assert.strictEqual(Voice.profile({ ...cold, persona: character(123).persona }).traits.empathy, 0.5, 'attached persona takes precedence');
    Persona.reset();
    assert.strictEqual(Voice.trait({}, 'empathy'), 0.5, 'missing personality is neutral, not zero');

    const warm = character(1, { sociability: 0.95, empathy: 0.95, caution: 0.8, assertiveness: 0.2 });
    const blunt = character(2, { sociability: 0.1, empathy: 0.1, caution: 0.2, assertiveness: 0.95 });
    assert(Voice.initiation(warm) > Voice.initiation(blunt));
    assert(Voice.closeChance(warm) > Voice.closeChance(blunt));
    assert(Voice.topicWeight(warm, 'company') > Voice.topicWeight(character(3, {}, 'wealth'), 'company'));
    assert(Voice.topicWeight(character(3, {}, 'wealth'), 'patience') > Voice.topicWeight(warm, 'patience'));
    assert(Voice.styleWeight(warm, 'warm') > Voice.styleWeight(blunt, 'warm') * 10);
    assert(Voice.styleWeight(blunt, 'direct') > Voice.styleWeight(warm, 'direct') * 5);

    // Sample the actual weighted phrase selector with identical random draws.
    // Each trial starts without history so repetition filtering cannot mask the trait effect.
    function supportiveLines(source) {
        let count = 0;
        for (let n = 0; n < 1000; n++) {
            Voice.reset(); Math.random = () => (n + 0.5) / 1000;
            if (Voice.line('reaction.global.death.reply', source, { name: 'Aria' }).includes('Happens to everyone')) count++;
        }
        return count;
    }
    assert(supportiveLines(warm) > supportiveLines(blunt) * 5, 'empathy materially changes delivered wording');
    const counts = [0, 0];
    for (let n = 0; n < 1000; n++) {
        const scene = { openerId: 8000, startedAt: 1000 + n, channel: 'global', topic: 'death' };
        for (const [index, source] of [warm, blunt].entries()) {
            const result = Voice.willingToReply(source, scene);
            assert.strictEqual(Voice.willingToReply(source, scene), result, 'repeated ticks do not reroll participation');
            if (result) counts[index]++;
        }
    }
    assert(counts[0] > counts[1] * 2, 'social, empathetic bots reply more often to setbacks');

    const styles = new Set(['social', 'reserved', 'warm', 'direct', 'careful', 'daring', 'driven', 'calm', 'weary', 'loyal', 'thrifty']);
    for (const [key, entries] of Object.entries(Speech.voices)) {
        for (const [style, template] of entries) {
            assert(styles.has(style), `unknown voice style in ${key}`);
            assert(template.length <= 120, `${key} should not depend on clipping`);
            assert(!/\{(?!name\}|responder\}|item\}|seller\}|level\}|goods\}|town\}|hp\})/.test(template), `${key} has an unsupported placeholder`);
        }
        const line = Voice.line(key, warm, { name: 'Aria', responder: 'Belen', item: 'Sword of Revolution', seller: 'Graham', level: 30, goods: 'Iron Ore - 500 adena each', town: 'Giran', hp: 25 });
        assert(line && line.length <= 120 && !/\{\w+\}/.test(line), key);
    }
    assert.strictEqual(Voice.line('reaction.global.death.reply', warm), '', 'missing names must not leak placeholders');
    assert.strictEqual(Voice.line('not-a-voice', warm), '');
    const purchases = [];
    const shopper = { ...warm, actor: { fetchId: () => 9001 } };
    const purchaseValues = { item: 'Sword of Revolution', seller: 'Graham' };
    assert(TownChatter.say(shopper, { say: (_source, text) => purchases.push(text) }, 'npc-gear-purchased',
        Speech.lines('town.npc-gear-purchased', purchaseValues), { values: purchaseValues, now: 200000 }));
    assert(purchases[0].includes(purchaseValues.item) && purchases[0].includes(purchaseValues.seller), 'personalized purchase retains the confirmed item and seller');
    assert(!/equipped|wielding/.test(purchases[0]), 'buying an item must not imply it was equipped');
    Voice.reset(); Math.random = () => 0;
    const first = Voice.line('reaction.global.death.reply', warm, { name: 'Aria' });
    const second = Voice.line('reaction.global.death.reply', warm, { name: 'Belen' });
    assert.notStrictEqual(first.replace('Aria', '?'), second.replace('Belen', '?'), 'changing names does not bypass repetition protection');

    // Follow a real global exchange and verify each turn uses its own author.
    Chat.reset();
    Config.chatReactionsEnabled = true; Config.chatReactionChance = 1; Config.globalChatEnabled = true;
    Config.globalChatChance = 1;
    const packets = [];
    // Isolated native listener identity; the tested authors retain IDs 1/2/123.
    publishSessions([presenceSession(8000002, 'player', packet => packets.push(packet))]);
    Response.speak = (actor, packet) => ({ id: actor.fetchId(), ...packet });
    const used = [];
    Voice.line = (key, source, ...args) => { used.push({ key, persona: Voice.profile(source) }); return original.line(key, source, ...args); };
    const startedAt = 1000000;
    assert(Chat.maybeAnnounce(warm, [], startedAt));
    const topic = used[0].key.slice('global.'.length);
    const scene = { channel: 'global', topic, openerId: 1, startedAt };
    const refused = Array.from({ length: 100 }, (_, n) => character(100 + n)).find(source => !Voice.willingToReply(source, scene));
    const accepted = Array.from({ length: 100 }, (_, n) => character(300 + n, blunt.persona.traits)).find(source => Voice.willingToReply(source, scene));
    assert(refused && accepted);
    for (let n = 0; n < 10; n++) assert(!Chat.offerReply(refused, startedAt + 3000 + n), 'a refusal survives repeated hot-style offers');
    assert(Chat.offerReply(accepted, startedAt + 3000));
    assert(Chat.offerReply(warm, startedAt + 6000));
    assert.strictEqual(packets.length, 3);
    assert.strictEqual(used.find(entry => entry.key.endsWith('.reply')).persona, accepted.persona);
    assert.strictEqual(used.find(entry => entry.key.endsWith('.close')).persona, warm.persona);
    assert.deepStrictEqual(packets.map(packet => packet.id), [1, accepted.characterId, 1]);
    used.length = 0;
    const a = { ...warm, actor: { fetchId: () => 1, fetchName: () => 'Aria' } };
    const b = { ...blunt, actor: { fetchId: () => 2, fetchName: () => 'Belen' } };
    const local = Conversation.chooseTopic(a, b);
    assert(local.opener && local.reply && local.closer);
    assert.strictEqual(used.find(entry => entry.key.endsWith('.reply')).persona, blunt.persona);
    assert.strictEqual(used.find(entry => entry.key.endsWith('.close')).persona, warm.persona, 'native local closer also uses the initiator');

    Voice.line = original.line;
    process.stdout.write(`Chat voice checks passed: identity, weighted wording, stable participation (${counts.join('/')}) and speaker ownership.\n`);
} finally {
    clearPublishedSessions();
    Database.execute = original.execute; Persona.reset(); Math.random = original.random;
    Voice.line = original.line; World.user = original.user; Response.speak = original.speak;
    console.info = original.info; Object.assign(Config, original.config); Chat.reset(); Voice.reset();
}
