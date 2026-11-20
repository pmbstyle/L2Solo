const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../src/Global');

function load(file, dependencies, globals = {}) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/' + file), 'utf8'), {
        module, invoke: name => dependencies[name], utils, path: { actor: 'generics' }, ...globals
    });
    return module.exports;
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function selectedPacket() {
    // Mobius C4, revision 6bc10d285b1bd7c0dc4f2a17b97af42f635f4712:
    // network/serverpackets/CharSelected.java. Decode through the last C4
    // field, rather than accepting frame padding as missing protocol fields.
    const GameTime = invoke('GameServer/World/GameTime');
    const original = GameTime.gameMinute;
    GameTime.gameMinute = () => 723;
    try {
        const actor = new Proxy({}, { get: (_target, name) => () => ({
            fetchName: 'Relog', fetchTitle: 'Title', fetchClassId: 88
        }[name] ?? 1) });
        const packet = invoke('GameServer/Network/Response/CharSelected')(actor);
        const reader = new (invoke('Packet/Receive'))(packet);
        reader.readS().readD().readS();
        assert.equal(reader.data[0], 'Relog');
        // Ten integers, HP/MP doubles, eleven integers, thirty reserved ints.
        const tail = reader.offset + 10 * 4 + 2 * 8 + 11 * 4 + 30 * 4;
        const expected = [0, 0, 723, 0, 88, ...Array(12).fill(0)];
        assert.deepEqual(expected.map((_, i) => packet.readInt32LE(tail + i * 4)), expected);
        const payloadEnd = tail + 17 * 4;
        const paddedEnd = Math.ceil(payloadEnd / 4) * 4;
        assert.equal(packet.length, paddedEnd + 4 + (paddedEnd + 4) % 8, 'full C4 payload plus transport padding');
    } finally { GameTime.gameMinute = original; }
}

async function restartLifecycle() {
    const save = deferred(), roster = deferred();
    const events = [];
    const actor = { fetchId: () => 10, setIsOnline(value) { events.push(['online', value]); },
        destructor() { events.push('destroy'); } };
    const session = { actor, socket: { destroyed: false },
        knownNpcIds: new Set([7]), knownCharacterActors: new Map([[8, {}]]),
        persistCharacterStatus: () => save.promise,
        dataSendToOthers: () => events.push('delete'), dataSendToMe: packet => events.push(packet) };
    const world = { retireUserActor: () => events.push('retire') };
    const response = { restart: () => 'restart', deleteOb: () => 'delete', charSelectInfo: () => 'hall' };
    const shared = load('GameServer/Network/Shared', { 'GameServer/World/World': world,
        'GameServer/Network/Response': response });
    shared.fetchCharacters = () => roster.promise;
    const restart = load('GameServer/Network/Request/Restart', {
        'GameServer/Network/Response': response, 'GameServer/Network/Shared': shared,
        'GameServer/World/World': world, 'GameServer/World/ArenaDuelService': { release() {} },
        'GameServer/World/Generics/NativeUiSession': { reset() {} },
        'GameServer/Bot/BotTradeService': { cleanup: () => events.push('trade') },
        'GameServer/Bot/AI/PartyCompanionService': { detachAll: () => events.push('party') }
    });
    const pending = restart(session);
    assert.equal(session.characterLeaving, true);
    await restart(session);
    assert.deepEqual(events, [], 'duplicate restart does not tear down during persistence');
    save.resolve();
    await settle();
    assert.deepEqual(events, ['trade', 'party', 'retire', ['online', false], 'delete', 'destroy', 'restart']);
    assert.equal(session.actor, null, 'restart ACK has no attached old actor');
    roster.resolve([]);
    await pending;
    assert.equal(events.at(-1), 'hall');
    assert.equal(session.characterLeaving, false);
    assert.equal(session.characterHall, true);
    assert.equal(session.knownNpcIds.size, 0);
    assert.equal(session.knownCharacterActors.size, 0);

    const Session = invoke('GameServer/Session');
    const Opcodes = invoke('GameServer/Network/Opcodes');
    const old = Opcodes.table[0x30];
    let dispatched = 0;
    Opcodes.table[0x30] = () => { dispatched++; };
    try {
        Session.prototype.dataReceive.call(session, Buffer.from([3, 0, 0x30]));
        assert.equal(dispatched, 0, 'late Appeared cannot access a hall actor');
        session.characterHall = false;
        session.characterLeaving = true;
        Session.prototype.dataReceive.call(session, Buffer.from([3, 0, 0x30]));
        assert.equal(dispatched, 0, 'world requests cannot run during the save');
    } finally { Opcodes.table[0x30] = old; }
}

async function loginCompletions() {
    for (const finish of ['normal', 'switch', 'hall', 'disconnect']) {
        const macros = deferred(), shortcuts = deferred(), skills = deferred();
        const sent = [], reads = [];
        let entries = 0;
        const actor = { fetchId: () => 10, backpack: { fetchItems: () => [] },
            enterWorld() { entries++; return skills.promise; } };
        const session = { actor, socket: { destroyed: false }, dataSendToMe: packet => sent.push(packet), dataSendToOthers() {} };
        const response = new Proxy({}, { get: (_target, name) => {
            if (name === 'macroList') return () => ['macro'];
            if (name === 'abnormalStatusUpdate' || name === 'shortBuffStatusUpdate') return { fromActor: () => name };
            return () => name;
        } });
        const enter = load('GameServer/Network/Request/EnterWorld', {
            'GameServer/Network/Response': response,
            Database: { fetchMacros(id) { reads.push(id); return macros.promise; },
                fetchShortcuts(id) { reads.push(id); return shortcuts.promise; } },
            'GameServer/Henna/HennaService': { restore: async () => {} },
            'GameServer/Clan/ClanService': { clanForActor: () => null },
            'GameServer/World/GameTime': { isNight: () => false },
            'GameServer/Quest/QuestService': { ensureLoaded: async () => {}, active: () => [] },
            'GameServer/Bot/Population/PopulationService': { requestPhaseScan() {} },
            'GameServer/AfkTrade/AfkTradeService': { deliverNotifications: async () => {} }
        }, { utils: { ...utils, infoWarn: (...args) => { throw new Error(args.join(' ')); } } });
        const pending = enter(session);
        await settle();
        enter(session);
        assert.equal(entries, 1, 'duplicate EnterWorld initializes only once');
        assert.deepEqual(sent, ['userInfo', 'itemsList'], 'local player is sent before inventory and environment');
        if (finish === 'switch') session.actor = { fetchId: () => 20 };
        if (finish === 'hall') session.actor = null;
        if (finish === 'disconnect') session.socket.destroyed = true;
        const before = sent.length;
        macros.resolve([]);
        skills.resolve();
        shortcuts.resolve([]);
        await pending;
        await settle();
        if (finish === 'normal') {
            assert.deepEqual(reads, [10, 10]);
            assert(sent.includes('shortcutInit'));
            assert(sent.includes('skillCoolTime'));
            assert(sent.includes('partySmallWindowDeleteAll'), 'new character starts with an empty native party window');
        } else {
            assert.equal(sent.length, before, `${finish}: stale entry sends no packets`);
            assert.deepEqual(reads, [10], 'stale macro read never starts a shortcut read for the next character');
        }
    }
}

async function staleHenna() {
    const Henna = invoke('GameServer/Henna/HennaService');
    const Database = invoke('Database');
    const original = Database.fetchCharacterHennas;
    const rows = deferred();
    Database.fetchCharacterHennas = () => rows.promise;
    try {
        const session = { actor: { fetchId: () => 10 }, hennas: [9], dataSendToMe() { throw new Error('stale HennaInfo'); } };
        const pending = Henna.restore(session);
        session.actor = { fetchId: () => 20 };
        rows.resolve([]);
        await pending;
        assert.deepEqual(session.hennas, [9], 'old tattoo restore cannot replace the current character state');
    } finally { Database.fetchCharacterHennas = original; }
}

function delayedNpcs() {
    for (const finish of ['normal', 'switch', 'hall', 'leaving', 'offline', 'teleport', 'disconnect']) {
        const timers = [], sent = [];
        let online = true;
        const actor = { teleportSequence: 0, fetchLocX: () => 1000, fetchLocY: () => 1000,
            fetchIsOnline: () => online };
        const session = { actor, socket: { destroyed: false }, dataSendToMe: packet => sent.push(packet) };
        const environment = load('GameServer/Actor/Generics/UpdateEnvironment', {
            'GameServer/Network/Response': { npcInfo: () => 'npc' },
            'GameServer/World/World': { fetchNpcsInRadius: () => [{ state: { fetchDead: () => false } }],
                fetchVisibleUsers: () => [] },
            'GameServer/World/WorldConstants': { CLIENT_VISIBILITY_RADIUS: 3000 },
            'GameServer/SpeckMath': invoke('GameServer/SpeckMath'),
            'GameServer/Npc/TownGuard': { engageNearby() {} },
            'GameServer/Npc/NpcAggro': { engageNearby() {} },
            'GameServer/AfkTrade/AfkTradeService': { refreshVisibility() {} }
        }, { require: () => ({ sync() {} }), setTimeout: callback => timers.push(callback) });
        environment(session, actor, { forceRefresh: true });
        assert.equal(timers.length, 1);
        if (finish === 'switch') session.actor = {};
        if (finish === 'hall') session.actor = null;
        if (finish === 'leaving') session.characterLeaving = true;
        if (finish === 'offline') online = false;
        if (finish === 'teleport') actor.teleportSequence++;
        if (finish === 'disconnect') session.socket.destroyed = true;
        timers[0]();
        assert.deepEqual(sent, finish === 'normal' ? ['npc'] : [], `${finish}: NPC timer belongs to its original scene`);
    }
}

async function cancelledActorEntry() {
    for (const phase of ['death', 'recommendations']) {
        const gate = deferred();
        let online = false;
        const actor = { setIsOnline() { online = true; } };
        const session = { actor };
        const enter = load('GameServer/Actor/Generics/EnterWorld', {
            'GameServer/Progression/DeathExperience': { load: () => phase === 'death' ? gate.promise : Promise.resolve() },
            'GameServer/Recommendations/Runtime': { refresh: () => gate.promise }
        });
        const pending = enter(session, actor);
        await settle();
        session.actor = null;
        gate.resolve();
        await pending;
        assert.equal(online, false, `entry cancelled during ${phase} cannot bring the retired actor online`);
    }
}

async function staleTradeNotifications() {
    const Database = invoke('Database');
    const original = Database.fetchAfkTradeNotifications;
    const rows = deferred();
    Database.fetchAfkTradeNotifications = () => rows.promise;
    try {
        const session = { actor: { fetchId: () => 10 }, dataSendToMe() { throw new Error('stale trade notification'); } };
        const pending = invoke('GameServer/AfkTrade/AfkTradeService').deliverNotifications(session);
        session.actor = null;
        rows.resolve([{ id: 1 }]);
        assert.equal(await pending, 0, 'old trade notifications stay unread when their character leaves');
    } finally { Database.fetchAfkTradeNotifications = original; }
}

function stalePvpFlag() {
    for (const finish of ['normal', 'switch', 'hall', 'leaving', 'disconnect']) {
        let expire;
        const sent = [], flags = [];
        const actor = { setPvpFlag: flag => flags.push(flag) };
        const session = { actor, socket: { destroyed: false }, dataSendToMe: packet => sent.push(packet), dataSendToOthers() {} };
        const flag = load('GameServer/Actor/PvpFlag', {
            'GameServer/PvpRules': {},
            'GameServer/Network/Response': { userInfo: () => 'userInfo', charInfo() {}, relationChanged() {} }
        }, { setTimeout: callback => { expire = callback; return 1; }, clearTimeout() {} });
        flag.mark(session, actor, 1000);
        assert.deepEqual(sent, ['userInfo']);
        if (finish === 'switch') session.actor = {};
        if (finish === 'hall') session.actor = null;
        if (finish === 'leaving') session.characterLeaving = true;
        if (finish === 'disconnect') session.socket.destroyed = true;
        expire();
        assert.equal(sent.length, finish === 'normal' ? 2 : 1, `${finish}: flag expiry cannot send old UserInfo`);
        assert.deepEqual(flags, finish === 'normal' ? [1, 0] : [1]);
    }
}

async function main() {
    selectedPacket();
    await restartLifecycle();
    await loginCompletions();
    await staleHenna();
    delayedNpcs();
    await cancelledActorEntry();
    await staleTradeNotifications();
    stalePvpFlag();
    console.log('C4 character relog packet and lifecycle checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
