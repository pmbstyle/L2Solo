'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const Index = require('../src/GameServer/World/CharacterLocationIndex');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-spatial-consumers-'));
const generated = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
const previous = { config: process.env.L2NODE_CONFIG_FILE, shared: process.env.L2NODE_SHARED_CONFIG_FILE };
const ini = path.join(directory, 'isolated.ini');
fs.writeFileSync(ini, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    .replace(/^\[Database\]\r?\npath\s*=\s*[^\r\n]+/m,
        `[Database]\npath = ${generated.world}\nhistoryPath = ${generated.history}`));
process.env.L2NODE_CONFIG_FILE = ini;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
let World, oldWorld;
const observations = [];
function check(name, body) { body(); observations.push(name); console.log('PASS ' + name); }

try {
    check('actor and state share one grid with exact live points', () => {
        const index = new Index(), loc = { locX: 7000, locY: 0, locZ: 0 }, source = {};
        const actor = { id: 1, source, phase: 'hot', order: 1, loc };
        index.setSource(1, 'actor', actor);
        const state = { id: 1, source: {}, phase: 'cold', loc: { locX: 0, locY: 0, locZ: 0 } };
        index.setSource(1, 'state', state);
        loc.locX = 7001;
        assert.deepEqual(index.nearSources({ locX: 7001, locY: 0, locZ: 0 }, 0, { view: 'actor' }), [actor]);
        index.clearSourceView('actor');
        assert.equal(index.sourceSize('actor'), 0);
        assert.equal(index.getSource(1, 'state'), state);
        assert.equal(index.rawSpatial, undefined);
    });

    require('../src/Global');
    World = invoke('GameServer/World/World'); oldWorld = { user: World.user, npc: World.npc };
    const Model = invoke('GameServer/Model/Actor');
    const Runtime = require('../src/GameServer/World/CharacterLocationRuntime');
    const Policy = invoke('GameServer/Bot/AI/HotActorLodPolicy');
    const Queries = require('../src/GameServer/World/ActorSpatialQueries');
    const Database = invoke('Database');
    let serial = 9980000;
    const member = (x, { bot = false, online = true, id = ++serial } = {}) => {
        const session = { accountId: (bot ? 'bot_' : 'player_') + id,
            fetchAccountId() { return this.accountId; }, socket: { destroy() {} },
            dataSendToMe() {}, dataSendToMeAndOthers() {}, dataSendToOthers() {} };
        const actor = new Model({ id, name: session.accountId, username: session.accountId, level: 35,
            isOnline: false, locX: x, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100, karma: 0 });
        session.actor = actor; actor.session = session;
        World.insertUser(session); actor.setIsOnline(online);
        return session;
    };
    World.user = { sessions: [], revision: 0 }; World.npc = { spawns: [], grid: {} };
    const bot = member(0, { bot: true }), player = member(3500), far = member(48000);
    check('native LOD boundaries, addressed selection and online events', () => {
        assert.equal(Policy.evaluate(bot, World, 20000).tier, 'full');
        player.actor.setLocX(3900);
        assert.equal(Policy.evaluate(bot, World, 21000).reason, 'distance_hysteresis');
        player.actor.setLocX(4001);
        assert.equal(Policy.evaluate(bot, World, 22000).tier, 'visible');
        player.actor.setLocX(6400);
        assert.equal(Policy.evaluate(bot, World, 23000).reason, 'outer_preload');
        far.actor.setDestId(bot.actor.fetchId());
        assert.equal(Policy.evaluate(bot, World, 24000).reason, 'player_selected');
        assert.deepEqual(World.actorPresenceSessions('onlineHuman', bot.actor.fetchId()), [far]);
        far.actor.clearDestId();
        assert.deepEqual(World.actorPresenceSessions('onlineHuman', bot.actor.fetchId()), []);
        far.actor.setIsOnline(false); player.actor.setIsOnline(false);
        assert.equal(World.actorPresenceCount(), 0);
        assert.equal(Policy.evaluate(bot, World, 40000).reason, 'no_real_players');
        player.actor.setIsOnline(true); player.actor.setLocX(6000);
        assert.equal(Policy.evaluate(bot, World, 41000).tier, 'visible');
        assert.equal(World.nearestRealPlayer({ locX: 0, locY: 0 }).session, player);
    });

    // Observe the entire authored Status module's lexical nearby consumer.
    const statusPath = path.join(root, 'src/GameServer/Bot/AI/BotStatus.js');
    const module = { exports: {} };
    const nearby = vm.compileFunction(fs.readFileSync(statusPath, 'utf8') + '\nreturn nearbySnapshot;',
        ['invoke', 'require', 'module', 'exports'], { filename: statusPath })(
        invoke, createRequire(statusPath), module, module.exports);
    const pk = invoke('GameServer/Bot/AI/States/PkHuntingState');
    check('32/64 distant original actors are untouched by status, PK and native LOD', () => {
        player.actor.setLocX(500); bot.hotActorLod = null;
        let reads = 0;
        const unrelated = [];
        for (let i = 0; i < 64; i++) {
            const candidate = member(120000 + i * 12000, { bot: true });
            const actor = candidate.actor;
            for (const name of ['fetchLocX', 'fetchLocY', 'fetchLocZ', 'fetchLevel', 'fetchKarma']) {
                const original = actor[name];
                actor[name] = function(...args) { reads++; return Reflect.apply(original, this, args); };
            }
            unrelated.push(candidate);
            if (i !== 31 && i !== 63) continue;
            reads = 0;
            const originalSessions = World.user.sessions;
            World.user.sessions = new Proxy(originalSessions, { get(target, key, receiver) {
                if (key === Symbol.iterator || ['filter', 'find', 'forEach'].includes(key)) throw Error('global sessions scan');
                return Reflect.get(target, key, receiver);
            } });
            try {
                const result = nearby(bot.actor);
                assert.equal(result.realPlayers, 1); assert.equal(result.friendlyBots, 0);
                assert.equal(Policy.evaluate(bot, World, 50000).tier, 'full');
                assert.deepEqual(pk.activeThreats(bot.actor, null), []);
                assert.equal(Queries.byId(World, player.actor.fetchId()), player);
                assert.equal(reads, 0);
            } finally { World.user.sessions = originalSessions; }
        }
        assert.equal(unrelated.length, 64);
    });

    check('same-ID replacement, raw terminal and null reset leave no stale presence', () => {
        const old = player.actor, id = old.fetchId();
        const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
        const target = { actorId: id };
        assert.equal(Navigation.resolveTargetActor(target), old);
        const replacement = member(7000, { id });
        assert.equal(Navigation.resolveTargetActor(target), replacement.actor);
        assert.equal(World.nearestRealPlayer({ locX: 0, locY: 0 }).session, replacement);
        old.setIsOnline(false); old.setDestId(bot.actor.fetchId()); old.setLocX(1);
        assert.equal(World.actorPresenceCount(), 1);
        assert.deepEqual(World.actorPresenceSessions('onlineHuman', bot.actor.fetchId()), []);
        const source = Runtime.index.getSource(id, 'actor').source;
        World.retireUserActor(replacement, replacement.actor);
        assert.equal(Runtime.index.getSource(id, 'actor').source, source);
        assert.equal(World.nearestRealPlayer({ locX: 0, locY: 0 }).session, null,
            'retired actors cannot remain nearby players');
        World.user = null;
        assert.equal(Runtime.index.presenceSize(), 0); assert.equal(Runtime.index.rawSpatial, undefined);
        assert.equal(World.actorPresenceCount(), 0);
    });

    assert.equal(Database.isReady(), false);
    assert.equal(fs.existsSync(generated.world), false); assert.equal(fs.existsSync(generated.history), false);
    console.log(JSON.stringify({ groups: observations.length, dbInitialized: false, generatedDatabaseFiles: 0 }));
} finally {
    if (World && oldWorld) { World.user = oldWorld.user; World.npc = oldWorld.npc; }
    for (const [key, value] of Object.entries({ L2NODE_CONFIG_FILE: previous.config, L2NODE_SHARED_CONFIG_FILE: previous.shared })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
}
