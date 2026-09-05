const assert = require('assert');
const { format } = require('util');
require('../src/Global');
const Chat = invoke('GameServer/Bot/AI/BotClanChat');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const Clan = invoke('GameServer/Clan/ClanService');
const Invite = invoke('GameServer/Clan/ClanInviteService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Manager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const saved = { user: World.user, find: Clan.findById, cached: Life.cachedState, session: Manager.findSessionById,
    speak: Response.speak, random: Math.random, now: Date.now, info: console.info, warn: utils.infoWarn, config: { ...Config } };
const packets = [], leaked = [], logs = [], cold = new Map(), hot = new Map();
let now = 1000000;
let clan;
function player(characterId, clanId, sink) {
    return { accountId: `player_${characterId}`, socket: { write() {} },
        actor: { fetchId: () => characterId, fetchClanId: () => clanId, fetchIsOnline: () => true },
        dataSendToMe: packet => sink.push(packet) };
}
function reset() {
    Chat.reset(); Voice.reset(); packets.length = 0; leaked.length = 0; logs.length = 0; cold.clear(); hot.clear(); now += 1000000;
    Config.clanChatEnabled = true; Math.random = () => 0;
    clan = { id: 11, members: [{ id: 1, name: 'Player' }] };
    for (let id = 101; id <= 109; id++) {
        const bot = { characterId: id, name: `Member${id}`, phase: 'cold', stats: {} };
        clan.members.push({ id, name: bot.name }); cold.set(id, bot);
    }
    cold.get(109).staticService = true;
    World.user = { sessions: [player(1, 11, packets), player(2, 12, leaked)] };
}
function drain() { for (let i = 0; i < 8; i++) { now += 8000; Chat.flush(now); } }
async function main() {
    try {
        Date.now = () => now;
        console.info = (...args) => logs.push(format(...args)); utils.infoWarn = () => {};
        Clan.findById = id => Number(id) === 11 ? clan : null;
        Life.cachedState = id => cold.get(id); Manager.findSessionById = id => hot.get(id);
        Response.speak = (actor, data) => ({ id: actor.fetchId(), name: actor.fetchName(), ...data });
        for (const [random, replies] of [[0, 2], [0.999, 5]]) {
            reset(); Math.random = () => random;
            assert(Chat.onJoined(cold.get(101), 11, now));
            assert.strictEqual(packets.length, 1, 'the newcomer greets first');
            assert.strictEqual(packets[0].id, 101);
            assert(!Chat.onJoined(cold.get(101), 11, now), 'duplicate join events must not replay the greeting');
            now += 3999; Chat.flush(now);
            assert.strictEqual(packets.length, 1, 'replies must have a human-sized pause');
            drain();
            assert.strictEqual(packets.length, replies + 1);
            assert.strictEqual(new Set(packets.map(packet => packet.id)).size, replies + 1, 'responders are distinct');
            assert.strictEqual(new Set(packets.map(packet => packet.text)).size, replies + 1, 'welcome wording does not repeat within the scene');
            assert(packets.slice(1).every(packet => packet.text.includes('Member101') && packet.id !== 109));
            assert(packets.every(packet => packet.kind === 4));
            assert.strictEqual(leaked.length, 0, 'outsiders never receive clan greetings');
            assert.strictEqual(logs.length, packets.length, 'each delivered message has one log record');
            assert(logs[0].includes('Member101 clan=11 topic=joined recipients=1 text='));
            assert(logs.slice(1).every(line => line.includes('topic=welcome')));
        }
        reset(); clan.members = clan.members.filter(member => [1,101,102].includes(member.id));
        Chat.onJoined(cold.get(101), 11, now); drain();
        assert.strictEqual(packets.length, 2, 'small clans use the available bot without inventing members');
        reset(); World.user.sessions = [player(2, 12, leaked)];
        assert(!Chat.onJoined(cold.get(101), 11, now));
        assert(!Chat.onDeath(cold.get(101), 'dead', now));
        assert.strictEqual(Chat.snapshot().pending, 0, 'pure bot clans do not accumulate chat scenes');
        assert.strictEqual(logs.length, 0);
        reset(); World.user.sessions[0].actor.fetchIsOnline = () => false;
        assert(!Chat.onJoined(cold.get(101), 11, now));
        assert.strictEqual(Chat.snapshot().pending, 0, 'an offline real member is not a listener');
        reset();
        assert(!Chat.onJoined(World.user.sessions[0], 11, now), 'never speak for a real player');
        assert(!Chat.onJoined(cold.get(109), 11, now), 'static services never greet');
        Config.clanChatEnabled = false;
        assert(!Chat.onJoined(cold.get(101), 11, now));
        assert.strictEqual(packets.length, 0);
        reset(); Chat.onJoined(cold.get(101), 11, now);
        clan.members = clan.members.filter(member => member.id !== 101); drain();
        assert.strictEqual(packets.length, 1, 'cancel welcomes when the newcomer leaves');
        reset(); Chat.onJoined(cold.get(101), 11, now);
        clan.members = clan.members.filter(member => ![102,103].includes(member.id)); drain();
        assert.strictEqual(packets.length, 1, 'members who left cannot send queued welcomes');
        reset(); Chat.onJoined(cold.get(101), 11, now);
        World.user.sessions = []; drain();
        assert.strictEqual(packets.length, 1, 'stop the scene when its last real listener disconnects');
        assert.strictEqual(Chat.snapshot().pending, 0);
        reset(); World.user.sessions[0].dataSendToMe = () => { throw new Error('socket closed'); };
        Chat.onJoined(cold.get(101), 11, now); drain();
        assert.strictEqual(logs.length, 0, 'failed sends must not be logged as sent');
        assert.strictEqual(Chat.snapshot().pending, 0, 'no replies follow an undelivered greeting');
        reset(); Chat.onJoined(cold.get(101), 11, now);
        now += Chat.QUEUE_TTL_MS; Chat.flush(now);
        assert.strictEqual(packets.length, 1, 'old welcome scenes expire');

        // Follow the real invitation path, including its successful membership write.
        reset();
        const actor = { fetchId: () => 101, fetchName: () => 'Member101', fetchIsOnline: () => true,
            fetchClanId: () => 11, fetchTitle: () => '', fetchLevel: () => 20, fetchClassId: () => 4, fetchClanPrivileges: () => 0 };
        const bot = { accountId: 'bot_101', actor, dataSendToMe() {}, dataSendToOthers() {} }; hot.set(101, bot);
        const originals = { add: Clan.addMember, can: Clan.canInvite, online: Clan.onlineSessions,
            refresh: Clan.refreshOnlineMembers, tell: Manager.botTell };
        try {
            Clan.canInvite = () => ({ ok: true, clan }); Clan.onlineSessions = () => [];
            Clan.refreshOnlineMembers = () => clan; Manager.botTell = () => {};
            Clan.addMember = async () => ({ ok: false, code: 'write_failed' });
            bot.pendingClanInvite = { clanId: 11, requestorSession: World.user.sessions[0] };
            assert(!(await Invite.accept(bot)).ok);
            assert.strictEqual(packets.length, 0, 'rejected joins produce no greeting');
            Clan.addMember = async () => ({ ok: true, clan, member: { id: 101 } });
            bot.pendingClanInvite = { clanId: 11, requestorSession: World.user.sessions[0] };
            assert((await Invite.accept(bot)).ok);
            assert.strictEqual(packets.length, 1, 'a committed invitation triggers the greeting');
            drain(); assert.strictEqual(packets.length, 3);
        } finally {
            Clan.addMember = originals.add; Clan.canInvite = originals.can; Clan.onlineSessions = originals.online;
            Clan.refreshOnlineMembers = originals.refresh; Manager.botTell = originals.tell;
        }
    } finally {
        World.user = saved.user; Clan.findById = saved.find; Life.cachedState = saved.cached;
        Manager.findSessionById = saved.session; Response.speak = saved.speak;
        Math.random = saved.random; Date.now = saved.now; console.info = saved.info; utils.infoWarn = saved.warn;
        Object.assign(Config, saved.config); Chat.reset(); Voice.reset();
    }
    console.log('Bot clan welcome checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
