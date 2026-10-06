'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread } = require('node:worker_threads');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
const helperPath = path.join(gameRoot, 'src/GameServer/World/PartyMembershipPublication.js');
const publish = require(helperPath);
const observations = [];

function nativeSnapshotProducer() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'party-snapshot-publication-'));
    const paths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
    const previousEnv = { config: process.env.L2NODE_CONFIG_FILE, shared: process.env.L2NODE_SHARED_CONFIG_FILE,
        knowledge: process.env.BOT_KNOWLEDGE_ERRORS_ENABLED };
    process.env.L2NODE_CONFIG_FILE = path.join(gameRoot, 'config/default.ini');
    delete process.env.L2NODE_SHARED_CONFIG_FILE;
    process.env.BOT_KNOWLEDGE_ERRORS_ENABLED = 'false';
    require(path.join(gameRoot, 'src/Global'));
    const previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
    options.default.Database.path = paths.world; options.default.Database.historyPath = paths.history;
    const World = invoke('GameServer/World/World'), Actor = invoke('GameServer/Model/Actor');
    const Life = invoke('GameServer/Bot/Population/BotLifeState'), Database = invoke('Database');
    const Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
    const previousUser = World.user, originalRefresh = World.refreshPartyMemberships;
    try {
        assert.equal(Database.isReady(), false);
        World.user = { sessions: [], revision: 0 };
        const id = 9985001;
        const session = { accountId: 'player_snapshot_publication', fetchAccountId() { return this.accountId; },
            socket: { destroy() {} }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {},
            coldLifeState: { phase: 'cold', party: { partyId: 'snapshot-publication' }, stats: { life: true } },
            coldMarketState: { phase: 'cold', stats: { market: true } }, coldCraftState: { phase: 'cold', stats: { craft: true } } };
        session.actor = new Actor({ id, name: session.accountId, username: session.accountId, clanId: 0, isOnline: false,
            locX: 0, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
        session.actor.session = session;
        World.insertUser(session); session.actor.setIsOnline(true);
        const record = World.registeredActorById(id), key = 'party:snapshot-publication';
        assert(record); assert.deepEqual(World.pvpPartySessionsForKey(key), [session]);
        const bucket = Runtime.index.groups.get(key), actorEntry = Runtime.index.records.get(id).actor;
        const membership = actorEntry.groupMembership;
        const accepted = Life.acceptLifecycleRow({ characterId: id, phase: 'cold', activity: 'hunting', level: 10,
            hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 1 });
        const stateRecord = Runtime.index.getSource(id, 'state'), stateBefore = structuredClone(accepted);
        const keys = ['coldLifeState', 'coldMarketState', 'coldCraftState'];
        const snapshots = keys.map(name => session[name]);
        let refreshCalls = 0;
        World.refreshPartyMemberships = function (changed) {
            refreshCalls += 1; assert.equal(this, World); assert.deepEqual(changed, [session]); assert.equal(changed[0], session);
            for (const name of keys) assert.equal(session[name].phase, 'hot', 'all three snapshots precede public refresh');
            return Reflect.apply(originalRefresh, this, [changed]);
        };
        assert.equal(Life.setSessionSnapshotsPhase(session, 'hot'), undefined);
        assert.equal(refreshCalls, 1);
        for (const [index, name] of keys.entries()) {
            assert.notEqual(session[name], snapshots[index]); assert.equal(snapshots[index].phase, 'cold');
            assert.deepEqual(session[name], { ...snapshots[index], phase: 'hot' });
        }
        assert.equal(World.registeredActorById(id), record); assert.equal(Runtime.index.records.get(id).actor, actorEntry);
        assert.equal(Runtime.index.groups.get(key), bucket); assert.equal(actorEntry.groupMembership, membership);
        assert.deepEqual(World.pvpPartySessionsForKey(key), [session]);
        assert.equal(Runtime.index.getSource(id, 'state'), stateRecord); assert.equal(stateRecord.source, accepted);
        assert.equal(Life.cachedState(id), accepted); assert.deepEqual(accepted, stateBefore);
        assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), []);
        observations.push({ name: 'actual exported Life snapshot producer refreshes after all three clones; current groups/state remain independent',
            refreshCalls, phases: keys.map(name => session[name].phase), sameBucketAndMetadata: true, sameOriginalActorState: true });
    } finally {
        World.refreshPartyMemberships = originalRefresh; World.user = previousUser;
        options.default.Database.path = previousPaths.world; options.default.Database.historyPath = previousPaths.history;
        for (const [key, value] of [['L2NODE_CONFIG_FILE', previousEnv.config], ['L2NODE_SHARED_CONFIG_FILE', previousEnv.shared],
            ['BOT_KNOWLEDGE_ERRORS_ENABLED', previousEnv.knowledge]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        const cleanup = { databaseReady: Database.isReady(), filesCreated: fs.readdirSync(directory), generatedPaths: paths,
            previousUserRestored: World.user === previousUser, originalRefreshRestored: World.refreshPartyMemberships === originalRefresh };
        fs.rmSync(directory, { recursive: true, force: true });
        cleanup.directoryRemoved = !fs.existsSync(directory);
        cleanup.worldAndHistoryAbsent = !fs.existsSync(paths.world) && !fs.existsSync(paths.history);
        observations.push({ name: 'native public snapshot cleanup; no SQL or initialized database', ...cleanup });
    }
}

const workerCode = String.raw`
    'use strict';
    const { parentPort, workerData, isMainThread } = require('node:worker_threads');
    const publish = require(workerData.helperPath);
    let loadCalls = 0, inputReads = 0;
    const changed = new Proxy([], { get() { inputReads += 1; throw new Error('worker inspected changed sources'); } });
    const result = publish(changed, () => { loadCalls += 1; throw new Error('worker loaded World'); });
    parentPort.postMessage({ result, loadCalls, inputReads, isMainThread, exportType: typeof publish,
        exportKeys: Object.keys(publish),
        rootModules: Object.keys(require.cache).filter(filename => filename.startsWith(workerData.rootSourcePrefix)),
        globals: { invoke: typeof global.invoke, options: typeof global.options, utils: typeof global.utils } });
    parentPort.close();
`;

async function main() {
    assert.equal(isMainThread, true);
    assert.equal(typeof global.invoke, 'undefined');
    assert.equal(typeof global.options, 'undefined');
    const originalInvoke = Object.getOwnPropertyDescriptor(global, 'invoke');
    let implicitLoads = 0, worker, joined = false, terminationCode = null;
    const implicitLoader = () => { implicitLoads += 1; throw new Error('implicit loader fallback'); };
    Object.defineProperty(global, 'invoke', { configurable: true, value: implicitLoader });
    try {
        const first = Object.freeze({ source: 'original-first' }), second = Object.freeze({ source: 'original-second' });
        for (const changed of [[first, second], new Set([first, second])]) {
            let loads = 0, calls = 0;
            const world = { refreshPartyMemberships(actual) {
                calls += 1; assert.equal(this, world); assert.equal(actual, changed);
                const values = [...actual]; assert.equal(values[0], first); assert.equal(values[1], second);
                return 17;
            } };
            const load = name => { loads += 1; assert.equal(name, 'GameServer/World/World'); return world; };
            assert.equal(publish(changed, load), 17); assert.equal(loads, 1); assert.equal(calls, 1);
        }
        assert.equal(implicitLoads, 0);
        observations.push({ name: 'pure Main forwards original Array/Set and session references through exact supplied loader', implicitLoads });

        const changed = [first];
        let missingLoads = 0;
        assert.throws(() => publish(changed, name => {
            missingLoads += 1; assert.equal(name, 'GameServer/World/World'); return {};
        }), TypeError);
        assert.equal(missingLoads, 1); assert.equal(implicitLoads, 0);
        assert.throws(() => publish(changed), TypeError); assert.equal(implicitLoads, 0);
        const loaderError = new Error('supplied-loader-failed');
        assert.throws(() => publish(changed, () => { throw loaderError; }), error => error === loaderError);
        const bridgeError = new Error('current-bridge-failed');
        const throwingWorld = { refreshPartyMemberships(actual) {
            assert.equal(this, throwingWorld); assert.equal(actual, changed); throw bridgeError;
        } };
        assert.throws(() => publish(changed, () => throwingWorld), error => error === bridgeError);
        assert.equal(implicitLoads, 0);
        observations.push({ name: 'missing Main bridge has no fallback; original supplied loader/bridge errors propagate', missingLoads, implicitLoads });

        assert.deepEqual(Object.keys(require.cache).filter(filename => filename.startsWith(path.join(gameRoot, 'src') + path.sep)), [helperPath]);
        if (originalInvoke) Object.defineProperty(global, 'invoke', originalInvoke);
        else delete global.invoke;
        nativeSnapshotProducer();

        worker = new Worker(workerCode, { eval: true, name: 'party-publication-boundary',
            workerData: { helperPath, rootSourcePrefix: path.join(gameRoot, 'src') + path.sep } });
        const finished = await new Promise((resolve, reject) => {
            let message;
            const timeout = setTimeout(() => reject(new Error('party publication boundary worker did not exit')), 5000);
            worker.once('message', value => { message = value; });
            worker.once('error', error => { clearTimeout(timeout); reject(error); });
            worker.once('exit', code => { clearTimeout(timeout); joined = true; resolve({ code, message }); });
        });
        assert.equal(finished.code, 0); assert(finished.message);
        assert.equal(finished.message.isMainThread, false);
        assert.equal(finished.message.result, 0); assert.equal(finished.message.loadCalls, 0);
        assert.equal(finished.message.inputReads, 0); assert.equal(finished.message.exportType, 'function');
        assert.deepEqual(finished.message.exportKeys, []);
        assert.deepEqual(finished.message.rootModules, [helperPath]);
        assert.deepEqual(finished.message.globals, { invoke: 'undefined', options: 'undefined', utils: 'undefined' });
        assert.equal(implicitLoads, 0);
        observations.push({ name: 'actual OSWorker native gate returns zero before source access/World loader', ...finished.message, exitCode: finished.code });
        console.log('OBSERVATIONS ' + JSON.stringify(observations));
    } finally {
        if (worker && !joined) { terminationCode = await worker.terminate(); joined = true; }
        if (global.invoke === implicitLoader) {
            if (originalInvoke) Object.defineProperty(global, 'invoke', originalInvoke);
            else delete global.invoke;
        }
        const loadedSources = Object.keys(require.cache).filter(filename => filename.startsWith(path.join(gameRoot, 'src') + path.sep))
            .map(filename => ({ path: filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }));
        const cleanup = { workerCreated: !!worker, joined, terminationCode, implicitLoads,
            implicitLoaderTrapRemoved: global.invoke !== implicitLoader, gameGlobalLoaded: loadedSources.some(source => source.path === path.join(gameRoot, 'src/Global.js')),
            databaseLoaded: loadedSources.some(source => source.path === path.join(gameRoot, 'src/Database.js')),
            worldLoaded: loadedSources.some(source => source.path === path.join(gameRoot, 'src/GameServer/World/World.js')) };
        if (process.env.N62_PARTY_WORKER_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.N62_PARTY_WORKER_EVIDENCE_DIR, 'observations.json'),
            JSON.stringify({ observations, cleanup, loadedSources }, null, 2) + '\n');
        console.log('CLEANUP ' + JSON.stringify(cleanup));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
