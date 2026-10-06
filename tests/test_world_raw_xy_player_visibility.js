'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'world-raw-xy-'));
const paths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
const previousEnv = { config: process.env.L2NODE_CONFIG_FILE, shared: process.env.L2NODE_SHARED_CONFIG_FILE,
    errors: process.env.BOT_KNOWLEDGE_ERRORS_ENABLED };
process.env.L2NODE_CONFIG_FILE = path.join(gameRoot, 'config/default.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.BOT_KNOWLEDGE_ERRORS_ENABLED = 'false';
require(path.join(gameRoot, 'src/Global'));
const previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
options.default.Database.path = paths.world;
options.default.Database.historyPath = paths.history;
const World = invoke('GameServer/World/World'), Actor = invoke('GameServer/Model/Actor');
const Life = invoke('GameServer/Bot/Population/BotLifeState'), Database = invoke('Database');
const Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
const previousUser = World.user, observations = [];
let serial = 9987000;

function build() {
    const id = ++serial, accountId = 'player_raw_producer_' + id;
    const session = { accountId, fetchAccountId() { return this.accountId; }, socket: { destroy() {} },
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {},
        coldLifeState: { party: { partyId: 'raw-producer' } } };
    const actor = new Actor({ id, name: accountId, username: accountId, clanId: 0, isOnline: false,
        locX: 0, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
    session.actor = actor; actor.session = session;
    return { session, actor, id };
}
function register(value) { World.insertUser(value.session); value.actor.setIsOnline(true); return value; }
function visible(locX, locY = 0) {
    return World.botVisibleRealPlayers({}, { fetchLocX: () => locX, fetchLocY: () => locY });
}
function observe(name, data = {}) { observations.push({ name, ...data }); console.log('PASS ' + name); }
function restoreEnv(key, value) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }

try {
    assert.equal(Database.isReady(), false);
    assert.equal(World.botRealPlayerIndex, true);
    World.user = { sessions: [], revision: 0 };
    const value = build(), notices = [], listenerErrors = [];
    const unsubscribe = World.subscribeUserChanges(id => {
        if (id !== value.id) return;
        try {
            const record = World.registeredActorById(id), entry = Runtime.index.records.get(id).actor;
            assert.equal(entry.record, record); assert.equal(entry.rawXY.record, record);
            assert.equal(entry.rawXY.loc, record.rawLoc);
            assert.equal(Runtime.index.cells.get(entry.rawXY.key).rawXY.has(entry), true);
            notices.push({ retired: record.retired });
        } catch (error) { listenerErrors.push(error); }
    });
    try {
        register(value);
        assert(notices.length); assert.deepEqual(listenerErrors, []);
        const original = World.registeredActorById(value.id), entry = Runtime.index.records.get(value.id).actor;
        const rawSet = Runtime.index.cells.get('0_0').rawXY, groupSet = Runtime.index.groups.get('party:raw-producer').entries;
        assert.equal(World.retireUserActor(value.session, value.actor), true);
        const retired = World.registeredActorById(value.id);
        assert.notEqual(retired, original); assert.notEqual(retired.token, original.token);
        assert.equal(Runtime.index.records.get(value.id).actor, entry);
        assert.equal(Runtime.index.cells.get('0_0').rawXY, rawSet);
        assert.equal(Runtime.index.groups.get('party:raw-producer').entries, groupSet);
        assert.equal(entry.rawXY.record, retired); assert.equal(entry.indexed, false);
        assert(notices.some(notice => notice.retired)); assert.deepEqual(listenerErrors, []);
        assert.equal(visible(0)[0], value.session);
        observe('actual attach and terminal renewal bind raw provider before notification on same entry and Sets');

        const accepted = Life.acceptLifecycleRow({ characterId: value.id, phase: 'cold', activity: 'hunting', level: 10,
            hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 1 });
        const stateRecord = Runtime.index.getSource(value.id, 'state'), stateBefore = structuredClone(accepted);
        const conserve = () => {
            assert.equal(World.registeredActorById(value.id), retired);
            assert.equal(retired.retired, true); assert.equal(entry.indexed, false);
            assert.equal(Runtime.index.groups.get('party:raw-producer').entries, groupSet);
            assert.equal(Runtime.index.getSource(value.id, 'state'), stateRecord);
            assert.equal(Life.cachedState(value.id), accepted); assert.deepEqual(accepted, stateBefore);
        };
        for (const work of [() => value.actor.setLocX(12000),
            () => value.actor.setLocY(24000),
            () => value.actor.setLocXYZ({ locX: 36000, locY: 0, locZ: NaN }),
            () => value.actor.setLocXYZH({ locX: 48000, locY: 0, locZ: NaN, head: 30 })]) {
            assert.equal(work(), undefined); conserve();
            assert.equal(visible(value.actor.fetchLocX(), value.actor.fetchLocY()).includes(value.session), true);
        }
        assert.equal(visible(0).includes(value.session), false);
        assert.equal(rawSet.has(entry), false);
        assert.equal(entry.rawXY.key, '8_0');
        observe('current terminal scalar/XYZ/XYZH crossings refresh raw without token/generic/state/group revival');

        value.actor.setLocXYZ({ locX: 1e100, locY: -1e100, locZ: NaN });
        conserve(); assert.equal(visible(1e100, -1e100)[0], value.session);
        let conversions = 0;
        const unsupported = { valueOf() { conversions++; return 0; }, toString() { conversions++; return '0'; } };
        value.actor.setLocX(unsupported);
        assert.equal(conversions, 0); assert.equal(entry.rawXY, null); conserve();
        assert.deepEqual(visible(0), []);
        value.actor.setLocX('0'); value.actor.setLocY(null);
        assert.equal(visible(0)[0], value.session); conserve();
        observe('terminal huge raw coordinates and unsupported provider disable/recovery retain original authority', { conversions });

        const heldUser = World.user, heldRecord = retired, heldState = stateRecord;
        World.user = { sessions: [], revision: 0 };
        assert.equal(entry.rawXY, null); assert.equal(rawSet.size, 0);
        assert.equal(Runtime.index.getSource(value.id, 'state'), heldState);
        value.actor.setLocXYZ({ locX: 6000, locY: 0, locZ: 0 });
        assert.equal(World.registeredActorById(value.id), null); assert.deepEqual(visible(6000), []);
        World.user = heldUser;
        assert.equal(World.registeredActorById(value.id), null); assert.deepEqual(visible(6000), []);
        assert.equal(heldRecord.retired, true);
        World.insertUser(value.session);
        assert.notEqual(World.registeredActorById(value.id), heldRecord);
        assert.equal(visible(6000)[0], value.session);
        assert.equal(Runtime.index.getSource(value.id, 'state'), heldState);
        observe('World reset and old arrays cannot rebuild raw sources; only explicit registration restores them');
    } finally { unsubscribe(); }
    assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), []);
} finally {
    const cleanup = { databaseReady: Database.isReady(), filesCreated: fs.readdirSync(directory), generatedPaths: paths,
        gameInitialized: false, sqlExecuted: false, workerCreated: false };
    World.user = previousUser;
    options.default.Database.path = previousPaths.world; options.default.Database.historyPath = previousPaths.history;
    restoreEnv('L2NODE_CONFIG_FILE', previousEnv.config); restoreEnv('L2NODE_SHARED_CONFIG_FILE', previousEnv.shared);
    restoreEnv('BOT_KNOWLEDGE_ERRORS_ENABLED', previousEnv.errors);
    fs.rmSync(directory, { recursive: true, force: true });
    Object.assign(cleanup, { previousUserRestored: World.user === previousUser,
        directoryRemoved: !fs.existsSync(directory), worldAndHistoryAbsent: !fs.existsSync(paths.world) && !fs.existsSync(paths.history) });
    const loadedSources = Object.keys(require.cache).filter(filename => filename.startsWith(path.join(gameRoot, 'src') + path.sep))
        .map(filename => ({ path: filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }));
    if (process.env.N62_RAW_XY_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.N62_RAW_XY_EVIDENCE_DIR, 'observations.json'),
        JSON.stringify({ observations, cleanup, loadedSources }, null, 2) + '\n');
    console.log('CLEANUP ' + JSON.stringify(cleanup));
}
