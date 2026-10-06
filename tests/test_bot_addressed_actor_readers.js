'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const readerRoot = path.resolve(process.env.N62_READER_SOURCE_ROOT || gameRoot);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'addressed-actor-readers-'));
const databasePaths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
const previousEnv = { config: process.env.L2NODE_CONFIG_FILE, shared: process.env.L2NODE_SHARED_CONFIG_FILE };
const configPath = path.join(directory, 'isolated.ini');
const defaultConfig = fs.readFileSync(path.join(gameRoot, 'config/default.ini'), 'utf8');
const databaseHeader = /^\[Database\]\r?\npath\s*=\s*[^\r\n]+/m;
assert(databaseHeader.test(defaultConfig));
fs.writeFileSync(configPath, defaultConfig.replace(databaseHeader,
    `[Database]\npath = ${databasePaths.world}\nhistoryPath = ${databasePaths.history}`));
process.env.L2NODE_CONFIG_FILE = configPath;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require(path.join(gameRoot, 'src/Global'));
const previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
options.default.Database.path = databasePaths.world;
options.default.Database.historyPath = databasePaths.history;
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Database = invoke('Database');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
const NpcIndex = require(path.join(gameRoot, 'src/GameServer/World/NpcObjectIndex'));
const previousWorld = { user: World.user, npc: World.npc };
const observations = [];
let serial = 9850000;

// Execute each complete authored module with its real relative dependencies.
// The lexical target helper is observable without adding a public game API.
function reader(relative, world = World, target = false) {
    const filename = path.join(readerRoot, relative);
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const load = vm.compileFunction(source + (target
        ? '\nreturn { api: module.exports, findTarget };'
        : '\nreturn module.exports;'), ['invoke', 'require', 'module', 'exports'], { filename });
    return load(name => name === 'GameServer/World/World' ? world : invoke(name),
        createRequire(path.join(gameRoot, relative)), module, module.exports);
}
const Pulling = reader('src/GameServer/Bot/AI/PartyPulling.js');
const Status = reader('src/GameServer/Bot/AI/BotStatus.js', World, true);
function reset() { World.user = { sessions: [], revision: 0 }; World.npc = { spawns: [] }; NpcIndex.reset(World); }
function build({ id = ++serial, account = `player_reader_${++serial}`, online = true, hp = 100, ...fields } = {}) {
    const session = { ...fields, accountId: account, fetchAccountId() { return this.accountId; },
        socket: { destroy() {} }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    const actor = new Actor({ id, name: account, username: account, level: 22, clanId: 0, isOnline: false,
        locX: 100, locY: 0, locZ: 0, head: 0, hp, maxHp: 100, mp: 100, maxMp: 100, karma: 0 });
    session.actor = actor; actor.session = session;
    return { session, actor, online };
}
function insert(value) {
    World.insertUser(value.session);
    if (value.online) value.actor.setIsOnline(true);
    return value.session;
}
function member(fields) { return insert(build(fields)); }
function target(id, observer) { return Status.findTarget({ currentTargetId: id }, observer.actor); }
function passed(name, details = {}) { observations.push({ name, ...details }); console.log(`PASS ${name}`); }
function restoreEnv(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }

try {
    assert.equal(Database.isReady(), false);
    reset();
    const leader = member(), peer = member({ partyCompanion: true, followPlayerSession: leader });
    const other = member({ hp: 0 });
    assert.equal(Pulling.hasDeadPartyMember(leader), false, 'unrelated death does not pause a pull');
    peer.actor.state.setDead(true);
    assert.equal(Pulling.hasDeadPartyMember(leader), false, 'the existing HP-based isDead predicate remains exact');
    peer.actor.model.hp = 0;
    assert.equal(Pulling.hasDeadPartyMember(leader), true);
    peer.actor.setIsOnline(false);
    peer.actor.setLocXYZ({ locX: NaN, locY: 0, locZ: NaN });
    assert.equal(Pulling.hasDeadPartyMember(leader), true, 'raw party membership keeps offline malformed-coordinate corpses');
    World.retireUserActor(peer, peer.actor);
    assert.equal(Pulling.hasDeadPartyMember(leader), true, 'registered terminal sources retain the original death eligibility');
    peer.actor.model.hp = 100;
    assert.equal(Pulling.hasDeadPartyMember(leader), false);
    const unregistered = build({ hp: 0 });
    assert.equal(Pulling.hasDeadPartyMember(unregistered.session), false, 'a live ID outside World is not added');
    passed('native party death predicate preserves raw membership and excludes unrelated/unregistered actors');

    const nextLeader = member();
    peer.actor.model.hp = 0; peer.followPlayerSession = nextLeader; World.refreshPartyMemberships([peer]);
    assert.equal(Pulling.hasDeadPartyMember(leader), false);
    assert.equal(Pulling.hasDeadPartyMember(nextLeader), true);
    const replacedId = peer.actor.fetchId();
    const replacement = member({ id: replacedId });
    assert.equal(Pulling.hasDeadPartyMember(nextLeader), false, 'same-ID replacement cannot leave a stale corpse candidate');
    World.removeUser(peer);
    assert.equal(World.registeredActorById(replacedId).session, replacement);
    assert.equal(Pulling.hasDeadPartyMember(nextLeader), false);
    leader.actor.model.hp = 0; leader.partyCompanion = true; leader.followPlayerSession = nextLeader;
    World.refreshPartyMemberships([leader]);
    assert.equal(Pulling.hasDeadPartyMember(leader), true, 'the registered caller remains eligible even when its own key redirects');
    World.removeUser(leader);
    assert.equal(Pulling.hasDeadPartyMember(leader), false, 'a removed caller is not seeded back into the result');
    passed('party move, same-ID displacement, delayed removal and caller registration lifetime');

    reset();
    const partyId = 'addressed-reader-party';
    const hotLeader = member({ hotBackgroundPartyId: partyId, coldLifeState: { party: { partyId: 'older-projection' } } });
    const hotPeer = member({ hotBackgroundPartyId: partyId, hp: 0 });
    const absent = build({ hotBackgroundPartyId: partyId, hp: 0 });
    Parties.acceptRow({ partyId, status: 'hot', leaderId: hotLeader.actor.fetchId(),
        memberIdsJson: JSON.stringify([hotLeader.actor.fetchId(), hotPeer.actor.fetchId(), absent.actor.fetchId()]),
        statsJson: '{}', updatedAt: 1 });
    assert.equal(Pulling.hasDeadPartyMember(hotLeader), true, 'autonomous membership uses the authoritative addressed hot roster');
    hotPeer.actor.model.hp = 100;
    assert.equal(Pulling.hasDeadPartyMember(hotLeader), false, 'an absent roster ID cannot become a live candidate');
    World.removeUser(hotPeer);
    hotPeer.actor.model.hp = 0;
    assert.equal(Pulling.hasDeadPartyMember(hotLeader), false);
    passed('autonomous hot roster survives a different cold projection and excludes absent native IDs');

    reset();
    const observer = member(), selected = member({ account: 'player_selected_target' });
    selected.actor.model.karma = 17;
    let result = target(selected.actor.fetchId(), observer);
    assert.deepEqual(result, { type: 'user', id: selected.actor.fetchId(), name: 'player_selected_target', level: 22,
        loc: { locX: 100, locY: 0, locZ: 0 }, distance: 0, dead: false, karma: 17 });
    const newTarget = member({ id: selected.actor.fetchId(), account: 'player_replacement_target' });
    assert.equal(target(newTarget.actor.fetchId(), observer).name, 'player_replacement_target');
    World.removeUser(selected);
    assert.equal(target(newTarget.actor.fetchId(), observer).name, 'player_replacement_target');
    assert.deepEqual(target(String(newTarget.actor.fetchId()), observer), { type: 'unknown', id: String(newTarget.actor.fetchId()) },
        'strict actor ID equality is preserved despite the numeric indexed lookup');
    assert.equal(target(0, observer), null);
    World.removeUser(newTarget);
    assert.deepEqual(target(newTarget.actor.fetchId(), observer), { type: 'unknown', id: newTarget.actor.fetchId() });
    const npc = build({ id: ++serial, account: 'fixture_npc' }).actor;
    npc.fetchAttackable = () => true; NpcIndex.add(World, npc);
    assert.equal(target(npc.fetchId(), observer).type, 'npc');
    assert.equal(target(npc.fetchId(), observer).attackable, true);
    npc.model.raidBoss = true;
    assert.equal(target(npc.fetchId(), observer), null, 'protected raid NPC behavior is unchanged');
    passed('addressed target summary, strict ID, current replacement, unknown and original NPC/raid continuation');

    const legacyLeader = build().session;
    const legacyDead = build({ partyCompanion: true, followPlayerSession: legacyLeader, hp: 0 }).session;
    const legacyTarget = build({ account: 'player_legacy_target' }).session;
    const legacyWorld = { user: { sessions: [other, legacyLeader, legacyDead, legacyTarget] }, npc: { spawns: [] } };
    const legacyPulling = reader('src/GameServer/Bot/AI/PartyPulling.js', legacyWorld);
    const legacyStatus = reader('src/GameServer/Bot/AI/BotStatus.js', legacyWorld, true);
    assert.equal(legacyPulling.hasDeadPartyMember(legacyLeader), true);
    legacyDead.actor.model.hp = 100;
    assert.equal(legacyPulling.hasDeadPartyMember(legacyLeader), false);
    assert.equal(legacyStatus.findTarget({ currentTargetId: legacyTarget.actor.fetchId() }, legacyLeader.actor).name, 'player_legacy_target');
    assert.deepEqual(legacyStatus.findTarget({ currentTargetId: String(legacyTarget.actor.fetchId()) }, legacyLeader.actor),
        { type: 'unknown', id: String(legacyTarget.actor.fetchId()) });
    passed('explicit injected worlds retain their original array readers and predicates');

    for (const count of [32, 64]) {
        reset();
        const chosen = member(), corpse = member({ partyCompanion: true, followPlayerSession: chosen, hp: 0 });
        assert.equal(Pulling.hasDeadPartyMember(chosen), true);
        assert.equal(target(corpse.actor.fetchId(), chosen).type, 'user');
        const unrelated = Array.from({ length: count }, () => member());
        assert.equal(Pulling.hasDeadPartyMember(chosen), true, 'genuine positive precedes access traps');
        assert.equal(target(corpse.actor.fetchId(), chosen).id, corpse.actor.fetchId());
        const restores = []; let unrelatedReads = 0;
        const patch = (object, field, descriptor) => {
            const previous = Object.getOwnPropertyDescriptor(object, field);
            Object.defineProperty(object, field, { configurable: true, ...descriptor });
            restores.push(() => { if (previous) Object.defineProperty(object, field, previous); else delete object[field]; });
        };
        for (const session of unrelated) {
            const actor = session.actor;
            for (const field of ['actor', 'partyCompanion', 'followPlayerSession', 'coldLifeState', 'hotBackgroundPartyId']) {
                const value = session[field]; patch(session, field, { get() { unrelatedReads++; return value; } });
            }
            for (const field of ['fetchId', 'fetchIsOnline', 'fetchLocX', 'fetchLocY', 'fetchLocZ', 'isDead']) {
                const original = actor[field];
                patch(actor, field, { value(...args) { unrelatedReads++; return Reflect.apply(original, this, args); } });
            }
        }
        const forbidden = () => { throw new Error('addressed reader enumerated the whole population'); };
        patch(World.user, 'sessions', { get: forbidden });
        for (const map of [Runtime.index.records, Runtime.index.sourceViews.actor, Runtime.index.sourceViews.state,
            Runtime.index.cells, Runtime.index.spots]) {
            for (const field of ['values', 'entries', Symbol.iterator]) patch(map, field, { value: forbidden });
        }
        let death, userTarget, missingTarget;
        try {
            death = Pulling.hasDeadPartyMember(chosen);
            userTarget = target(corpse.actor.fetchId(), chosen);
            missingTarget = target(++serial, chosen);
        } finally { for (const restore of restores.reverse()) restore(); }
        assert.equal(death, true); assert.equal(userTarget.id, corpse.actor.fetchId());
        assert.deepEqual(missingTarget, { type: 'unknown', id: serial });
        assert.equal(unrelatedReads, 0);
        passed(`native readers avoid roster enumeration and ${count} unrelated actors`, { unrelatedReads });
    }
    assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), ['isolated.ini']);
    assert.equal(fs.existsSync(databasePaths.world), false);
    assert.equal(fs.existsSync(databasePaths.history), false);
    console.log('OBSERVATIONS ' + JSON.stringify(observations));
} finally {
    const cleanup = { databaseReady: Database.isReady(), filesCreated: fs.readdirSync(directory), sqlExecuted: false,
        worldInitialized: false, workerCreated: false };
    World.user = previousWorld.user; World.npc = previousWorld.npc;
    options.default.Database.path = previousPaths.world; options.default.Database.historyPath = previousPaths.history;
    restoreEnv('L2NODE_CONFIG_FILE', previousEnv.config); restoreEnv('L2NODE_SHARED_CONFIG_FILE', previousEnv.shared);
    fs.rmSync(directory, { recursive: true, force: true });
    cleanup.directoryRemoved = !fs.existsSync(directory);
    cleanup.worldAndHistoryAbsent = !fs.existsSync(databasePaths.world) && !fs.existsSync(databasePaths.history);
    console.log('CLEANUP ' + JSON.stringify(cleanup));
}
