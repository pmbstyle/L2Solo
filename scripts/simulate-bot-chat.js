// Deterministic offline chat preview. Uses production speech/routing code with
// in-memory actors and packet sinks; never starts the server or reads bot rows.
const assert = require('assert');
const { performance } = require('perf_hooks');
require('../src/Global');
const Chat = invoke('GameServer/Bot/Population/BotGlobalChat');
const Reactions = invoke('GameServer/Bot/AI/BotChatReactions');
const Budget = invoke('GameServer/Bot/AI/BotChatterBudget');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const BotAI = invoke('GameServer/Bot/BotAI');
const Manager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Persona = invoke('GameServer/Bot/AI/BotPersona');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');

const saved = { now: Date.now, random: Math.random, info: console.info, user: World.user,
    visible: World.fetchVisibleRealPlayers, speak: Response.speak, sessions: Manager.sessions, config: { ...Config } };
const duration = 30 * 60000;
const epoch = 1000000;
const argument = (name, fallback) => Number(process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const population = argument('bots', 1700);
const initialSeed = argument('seed', 42);
const hotCount = process.argv.includes('--cold-only') ? 0 : 8;
assert(Number.isInteger(population) && population >= Math.max(1, hotCount) && population <= 100000);
assert(Number.isInteger(initialSeed));
let elapsed = 0, seed = initialSeed, offers = 0, maxScenes = 0;
const transcript = [];
const started = performance.now();
function actor(id, name, x) {
    return { fetchId: () => id, fetchName: () => name, fetchLocX: () => x,
        fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false };
}
function record(packet) {
    transcript.push({ at: elapsed, ...packet });
}
try {
    Date.now = () => epoch + elapsed;
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    console.info = () => {};
    // Exercise production defaults instead of pinning an older chat budget.
    const players = [0, 10000].map((x, index) => ({ accountId: `viewer_${index}`, actor: actor(9000 + index, 'Viewer', x),
        socket: { write() {} }, dataSendToMe(packet) { if (index === 0) record(packet); } }));
    World.user = { sessions: players };
    World.fetchVisibleRealPlayers = (_session, speaker) => players.filter(player =>
        Math.abs(player.actor.fetchLocX() - speaker.fetchLocX()) < 2000);
    Response.speak = (speaker, data) => ({ id: speaker.fetchId(), name: speaker.fetchName(), ...data });
    const names = ['Aria', 'Belen', 'Caelan', 'Dara', 'Elora', 'Finn', 'Garen', 'Hana'];
    const hot = names.slice(0, hotCount).map((name, index) => ({ botSession: true, accountId: `bot_${index + 1}`,
        actor: actor(index + 1, name, Math.floor(index / 4) * 10000 + index % 4 * 100), plan: 'resting',
        persona: Persona.generate({ characterId: index + 1 }),
        dataSendToOthers(packet) { if (World.fetchVisibleRealPlayers(this, this.actor).length) record(packet); } }));
    Manager.sessions = hot;
    const cold = Array.from({ length: population - hotCount }, (_, index) => ({ characterId: index + 100,
        name: `Wanderer${index + 1}`, phase: 'cold', activity: 'resting', vitals: { hp: 100 } }));
    const sources = new Map([...hot.map(source => [source.actor.fetchId(), source]), ...cold.map(source => [source.characterId, source])]);
    Budget.reset(); Chat.reset();
    for (elapsed = 0; elapsed < duration; elapsed += 1000) {
        // A deliberately busy upper-bound fixture: all fresh cold states
        // are offered every five seconds. This tests cost and chorus control.
        if (elapsed % 5000 === 0) {
            for (let index = 0; index < cold.length; index++) {
                const state = cold[index];
                if (state.reviveAt && elapsed >= state.reviveAt) { state.activity = 'resting'; state.vitals.hp = 100; }
                const died = elapsed % 300000 === 0 && index === elapsed / 300000;
                if (died) { state.activity = 'dead'; state.vitals.hp = 0; state.reviveAt = elapsed + 15000; }
                Chat.maybeAnnounce(state, died ? [{ type: 'death' }] : []);
                offers++;
            }
        }
        // Normal hot opportunities, with no separate timer per conversation.
        for (const session of hot) { Chat.offerReply(session); Reactions.offerLocal(session); }
        if (hot.length && elapsed % 30000 === 0) Chat.maybeAmbient(hot[Math.floor(elapsed / 30000) % hot.length]);
        if (hot.length && elapsed % 60000 === 0) {
            for (let room = 0; room < 2; room++) {
                const session = hot[room * 4 + Math.floor(elapsed / 60000) % 4];
                if (elapsed % 180000 === 0) {
                    TownChatter.say(session, BotAI, 'npc-gear-purchased', Speech.lines('town.npc-gear-purchased', {
                        item: 'Sword of Revolution', seller: 'Graham'
                    }), { values: { item: 'Sword of Revolution', seller: 'Graham' } });
                } else BotAI.say(session, Speech.line('combat.rest'), { ambient: true, key: 'rest' });
            }
        }
        maxScenes = Math.max(maxScenes, Reactions.snapshot().local);
    }
    const globalLines = transcript.filter(line => line.kind === 1);
    const localLines = transcript.filter(line => line.kind === 0);
    const normalized = globalLines.map(line => line.text.replace(/Wanderer\d+|Aria|Belen|Caelan|Dara|Elora|Finn|Garen|Hana/g, '{name}'));
    const distinct = new Set(normalized).size;
    assert(globalLines.length <= Math.ceil(duration / Config.globalChatMinIntervalMs) + 2);
    if (population >= 100) assert(globalLines.length >= 30, 'a populated world should not have a nearly silent global chat');
    assert(maxScenes <= Reactions.MAX_LOCAL_SCENES);
    assert(transcript.every(line => line.text.length <= 120 && !/\{\w+\}/.test(line.text)));
    process.stdout.write(`Offline chat simulation: 30 minutes, ${cold.length} cold bots, ${hot.length} hot bots, ${hot.length ? 2 : 0} local areas, seed ${initialSeed}.\n`);
    process.stdout.write(`${offers.toLocaleString('en-US')} cold opportunities; ${globalLines.length} global lines; ${localLines.length} local lines; max ${maxScenes} local scenes.\n`);
    process.stdout.write(`${distinct} distinct global phrases (speaker names ignored); ${new Set(globalLines.map(line => line.id)).size} global speakers.\n`);
    process.stdout.write(`Runtime: ${(performance.now() - started).toFixed(0)} ms. No LLM, database or network requests.\n\n`);
    for (const line of transcript) {
        const minute = String(Math.floor(line.at / 60000)).padStart(2, '0');
        const second = String(Math.floor(line.at / 1000) % 60).padStart(2, '0');
        const profile = process.argv.includes('--profiles') ? ` (${Voice.profile(sources.get(line.id))?.archetype || 'unknown'})` : '';
        process.stdout.write(`${minute}:${second} [${line.kind === 1 ? 'global' : 'local'}] ${line.name}${profile}: ${line.text}\n`);
    }
} finally {
    Date.now = saved.now; Math.random = saved.random; console.info = saved.info;
    World.user = saved.user; World.fetchVisibleRealPlayers = saved.visible;
    Response.speak = saved.speak; Manager.sessions = saved.sessions; Object.assign(Config, saved.config);
    Chat.reset(); Budget.reset(); Reactions.reset();
}
