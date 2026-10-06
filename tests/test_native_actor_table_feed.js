'use strict';

// Actual production helpers,
// native MessagePort and Protocol table_page; no game ColdSimulationWorker.
// Fixture reply/control messages are observations, never gameplay ACKs. Actual
// default Coordinator attach/post and early-stop fence; no DB startup lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Worker, MessagePort, parentPort, isMainThread, workerData, threadId } = require('node:worker_threads');
const gameRoot = path.resolve(isMainThread
    ? process.env.N53_GAME_ROOT || path.join(__dirname, '..') : workerData.sourceRoot);
const moduleAt = name => require(path.join(gameRoot, 'src/GameServer', name));
const FIRST = 9998101;
const point = Object.freeze({ locX: 0, locY: 0, locZ: 0 });
const turn = () => new Promise(resolve => setImmediate(resolve));

function childMain() {
    const port = parentPort, epoch = workerData.workerEpoch, previousLoad = Module._load;
    assert(port instanceof MessagePort);
    const forbidden = filename => /[/\\]src[/\\](Global|Database)\.js$/.test(filename)
        || /[/\\]World[/\\]World\.js$/.test(filename) || /[/\\]ColdSimulationWorker\.js$/.test(filename);
    Module._load = function(request, parent, ...rest) {
        const filename = Module._resolveFilename(request, parent);
        if (forbidden(filename)) throw new Error('forbidden_helper_game_import:' + filename);
        return Reflect.apply(previousLoad, this, [request, parent, ...rest]);
    };
    const Runtime = moduleAt('World/CharacterLocationRuntime');
    const Mirror = moduleAt('Bot/Population/TableMirror');
    const Sources = moduleAt('World/CharacterActorSources');
    const Protocol = moduleAt('Bot/Population/ColdSimulationProtocol');
    const ColdActorTableReceiver = moduleAt('Bot/Population/ColdActorTableReceiver');
    const index = Runtime.index, role = Runtime.beginWorkerProjectorRole(epoch);
    const tables = new Mirror({ actorProjectorRole: role }), native = Sources.native();
    let backing;
    const owner = tables.attachStore('actors', (actualOwner, descriptor) => {
        backing = native.createStore(actualOwner, descriptor); return backing;
    });
    const privateReads = Runtime.actorProducerReads();
    const state = { characterId: FIRST, phase: 'cold', inventory: { 1864: { amount: 12 } } };
    const stateRecord = { id: FIRST, source: state, phase: 'cold', loc: () => point };
    index.setSource(FIRST, 'state', stateRecord);
    let active = true, pages = 0, unknownWindows = 0, identities = 0, stopOnTerminal = false, actorStopped = false;
    const cleanups = [];
    const stateGood = () => index.getSource(FIRST, 'state') === stateRecord
        && stateRecord.source === state && state.inventory[1864].amount === 12;
    const unknown = () => {
        let caught = false;
        try { index.sourceSize('actor'); }
        catch (error) { caught = error?.code === 'CHARACTER_ACTOR_VIEW_UNKNOWN'; }
        assert.equal(caught, true); unknownWindows++;
    };
    const report = () => {
        if (!active || !tables.ready('actors')) return;
        const rows = Array.from(tables.rows('actors').values());
        const originals = rows.every(row => index.getSource(row.id, 'actor').source === row);
        const humans = rows.filter(row => row.presence.online && row.presence.realPlayer);
        assert.equal(index.presenceSize(), humans.length);
        assert.equal(index.presenceSources().every(record => rows.includes(record.source)), true);
        const nearest = index.nearestFacet(point, { kind: 'player' });
        const expected = humans.filter(row => ['number', 'string', 'boolean', 'null'].includes(row.axes.x.tag)
            && ['number', 'string', 'boolean', 'null'].includes(row.axes.y.tag))
            .map(row => ({ row, distance: Math.hypot(Number(row.axes.x.value ?? 0), Number(row.axes.y.value ?? 0)) }))
            .filter(value => Number.isFinite(value.distance)).sort((a, b) => a.distance - b.distance || a.row.order - b.row.order)[0];
        assert.equal(nearest?.record.source ?? null, expected?.row ?? null);
        port.postMessage({ kind: 'known', epoch, rows, pages, unknownWindows, identities,
            chain: tables.tables.get('actors').chain, version: tables.tables.get('actors').version, cleanups: [...cleanups],
            rawCount: index.nearFacet(point, 6000).length, stateOriginal: stateGood(), originals });
    };
    // Delegating scalar observation of the PRODUCTION receiver's cleanup only.
    const originalCleanup = tables.cleanupStore;
    tables.cleanupStore = function(...args) {
        const chain = this.tables.get('actors').chain;
        const result = Reflect.apply(originalCleanup, this, args);
        cleanups.push({ ...result, limit: args[1], copyId: chain.copyId, worldGeneration: chain.worldGeneration }); return result;
    };
    const receiver = new ColdActorTableReceiver({ mirror: tables, owner,
        onResync(names) { port.postMessage(Protocol.envelope('table_resync', epoch, { names })); },
        onReady: report });
    const finish = () => {
        active = false; receiver.stop(); unknown();
        assert.equal(Sources.actorStoreIndex(owner), null); assert.equal(stateGood(), true);
        assert.equal(privateReads, Runtime.actorProducerReads()); // Index lifetime, not owner lifetime.
        assert.deepEqual(Object.keys(require.cache).filter(forbidden), []);
        assert.equal(global.invoke, undefined); assert.equal(global.options, undefined);
        assert.equal(fs.existsSync(workerData.generated.world), false);
        assert.equal(fs.existsSync(workerData.generated.history), false);
        Module._load = previousLoad;
        port.postMessage({ kind: 'stopped', epoch, stateOriginal: true, helperOnly: true });
        port.close();
    };
    const abort = error => {
        active = false; Module._load = previousLoad;
        port.postMessage({ kind: 'failure', epoch, error: String(error?.stack || error) });
        port.close(); process.exitCode = 1;
    };
    unknown(); assert.equal(native.index, index); assert.equal(Runtime.nativeActorMirror(), tables);
    assert.equal(Sources.actorStoreMatches(owner, backing), true);
    port.on('message', message => {
        if (!active) return;
        try {
            if (message?.kind === 'fixture_stop' && message.epoch === epoch) { finish(); return; }
            if (message?.kind === 'fixture_stop_on_terminal' && message.epoch === epoch) {
                stopOnTerminal = true; port.postMessage({ kind: 'stop_armed', epoch }); return;
            }
            const check = Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch });
            if (!check.ok) {
                assert.equal(check.reason, 'stale_epoch');
                port.postMessage({ kind: 'rejected_epoch', epoch, reason: check.reason }); return;
            }
            assert.equal(message.type, 'table_page');
            const pieces = message.payload.tables;
            if (pieces.some(piece => piece.name === 'actors')) pages++;
            const resync = receiver.apply(pieces);
            assert(resync.every(name => name === 'actors'));
            const lastRows = new Map();
            for (const piece of message.payload.tables) {
                if (piece.name !== 'actors') continue;
                assert(piece.rows.length + piece.removed.length <= 64);
                for (const [id, received] of piece.rows) lastRows.set(id, received);
            }
            if (actorStopped) {
                unknown(); assert.equal(Sources.actorStoreIndex(owner), null); assert.equal(stateGood(), true);
            } else {
                // A finite baseline and dirty cut may supersede the same ID.
                // Whole-apply identity belongs to its last accepted original.
                for (const [id, received] of lastRows) {
                    assert.equal(privateReads.getSource(id, 'actor').source, received); identities++;
                }
            }
            if (!tables.ready('actors')) unknown();
            for (const piece of pieces) {
                if (piece.name !== 'fixture_ordinary') continue;
                for (const [id, row] of piece.rows) assert.equal(tables.rows(piece.name).get(id), row);
                port.postMessage({ kind: 'ordinary', epoch, rows: [...tables.rows(piece.name).values()],
                    actorReady: tables.ready('actors'), stateOriginal: stateGood() });
            }
            if (stopOnTerminal && pieces.some(piece => piece.name === 'actors' && piece.last === 1)) {
                stopOnTerminal = false;
                assert.equal(tables.ready('actors'), false);
                assert.equal(tables.tables.get('actors').cleanupComplete, false);
                const before = cleanups.length; receiver.stop(); actorStopped = true; unknown();
                setImmediate(() => {
                    try {
                        assert.equal(cleanups.length, before); assert.equal(stateGood(), true);
                        port.postMessage({ kind: 'actor_stopped', epoch, cleanupCancelled: true, stateOriginal: true });
                    } catch (error) { abort(error); }
                });
            }
        } catch (error) { abort(error); }
    });
    port.postMessage({ kind: 'helper_ready', epoch, threadId, helperOnly: true });
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n62-native-messageport-'));
    const generated = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
    const environmentKeys = ['L2NODE_CONFIG_FILE', 'L2NODE_SHARED_CONFIG_FILE', 'BOT_KNOWLEDGE_ERRORS_ENABLED'];
    const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    const previousCwd = process.cwd(), receivers = [], waiters = [], sent = [], budgets = [], observations = [];
    let World, Actor, Life, Database, Runtime, issuer, channel, coordinator, previousUser, previousPaths, previousKnowledge;
    let activeReceiver = null, serial = FIRST - 1, originalPump, originalPost, ordinaryRegistered = false;
    const ordinaryRows = [{ id: 1, value: 1 }];
    const failure = { value: null };
    const wake = () => { for (const notify of [...waiters]) notify(); };
    const wait = predicate => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { remove(); reject(new Error('native stream fixture timed out')); }, 10000);
        const remove = () => { clearTimeout(timeout); const at = waiters.indexOf(check); if (at >= 0) waiters.splice(at, 1); };
        const check = () => {
            if (failure.value) { remove(); reject(failure.value); return; }
            const result = predicate(); if (result) { remove(); resolve(result); }
        };
        waiters.push(check); check();
    });
    const createReceiver = async epoch => {
        const receiver = { epoch, live: true, messages: [], joined: false }; receivers.push(receiver);
        const env = { ...process.env, N53_GAME_ROOT: gameRoot }; delete env.NODE_OPTIONS;
        receiver.worker = new Worker(__filename, { name: 'native-actor-stream-helper', execArgv: [], env,
            workerData: { sourceRoot: gameRoot, workerEpoch: epoch, generated } });
        receiver.worker.on('message', message => {
            receiver.messages.push(message);
            if (message.kind === 'failure') failure.value = new Error(message.error);
            if (message.type === 'table_resync') {
                Promise.resolve(coordinator.onMessage(message, receiver.worker, epoch))
                    .catch(error => { failure.value = error; wake(); });
            }
            wake();
        });
        receiver.exit = new Promise(resolve => receiver.worker.once('exit', code => {
            receiver.joined = true;
            if (!receiver.messages.some(message => message.kind === 'stopped')) failure.value ||= new Error(`helper early exit ${code}`);
            resolve(code); wake();
        }));
        receiver.worker.on('error', error => { failure.value = error; wake(); });
        await wait(() => receiver.messages.find(message => message.kind === 'helper_ready')); return receiver;
    };
    const known = (receiver, predicate) => wait(() => receiver.messages.findLast(message =>
        message.kind === 'known' && message.epoch === receiver.epoch && message.originals && message.stateOriginal && predicate(message)));
    const member = ({ id = ++serial, account = `player_stream_${id}`, locX = 0 } = {}) => {
        const session = { accountId: account, fetchAccountId() { return this.accountId; },
            socket: { destroy() { session.destroyed = true; } }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
        session.actor = new Actor({ id, username: account, name: account, clanId: 0, isOnline: false,
            locX, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
        session.actor.session = session; World.insertUser(session); session.actor.setIsOnline(true); return session;
    };
    try {
        process.chdir(gameRoot);
        const configPath = path.join(directory, 'isolated.ini');
        const config = fs.readFileSync(path.join(gameRoot, 'config/default.ini'), 'utf8');
        const header = /^\[Database\]\r?\npath\s*=\s*[^\r\n]+/m;
        assert(header.test(config));
        fs.writeFileSync(configPath, config.replace(header,
            `[Database]\npath = ${generated.world}\nhistoryPath = ${generated.history}`));
        process.env.L2NODE_CONFIG_FILE = configPath;
        delete process.env.L2NODE_SHARED_CONFIG_FILE; process.env.BOT_KNOWLEDGE_ERRORS_ENABLED = 'false';
        require(path.join(gameRoot, 'src/Global'));
        previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
        previousKnowledge = options.default.BotPopulation.knowledgeErrorsEnabled;
        options.default.Database.path = generated.world; options.default.Database.historyPath = generated.history;
        options.default.BotPopulation.knowledgeErrorsEnabled = false;
        World = invoke('GameServer/World/World'); Actor = invoke('GameServer/Model/Actor');
        Life = invoke('GameServer/Bot/Population/BotLifeState'); Database = invoke('Database');
        Runtime = moduleAt('World/CharacterLocationRuntime'); previousUser = World.user;
        assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), ['isolated.ini']);
        World.user = null;
        issuer = moduleAt('World/MainActorPublicationSource').native();
        const TableChannel = moduleAt('Bot/Population/ColdTableChannel');
        const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').ColdSimulationCoordinator;
        const Protocol = moduleAt('Bot/Population/ColdSimulationProtocol');
        coordinator = new Coordinator(); channel = coordinator.tableChannel;
        assert.equal(channel, TableChannel.shared);
        // Observe actual pump work, never substitute a provider/result or assert
        // inside the production scheduling catch boundary.
        originalPump = channel.pumpActor;
        channel.pumpActor = function(...args) {
            const before = { ...this.actorStats };
            try { return Reflect.apply(originalPump, this, args); }
            finally { budgets.push({ inspected: this.actorStats.inspections - before.inspections,
                receipts: this.actorStats.receiptChecks - before.receiptChecks }); }
        };
        originalPost = coordinator.post;
        coordinator.post = function(type, payload, msgId, bytes) {
            const result = Reflect.apply(originalPost, this, [type, payload, msgId, bytes]);
            if (type === 'table_page' && result) {
                const actors = payload.tables.filter(piece => piece.name === 'actors');
                if (actors.length) sent.push({ epoch: this.workerEpoch, payload, declaredBytes: bytes,
                    entries: actors.reduce((sum, piece) => sum + piece.rows.length + piece.removed.length, 0) });
            }
            return result;
        };
        // Ordinary provider is fixture-only; native actors are registered by
        // the ACTUAL default Coordinator below, not by this fixture.
        channel.register('fixture_ordinary', { key: row => row.id, allRows: () => ordinaryRows, eventDriven: true });
        ordinaryRegistered = true;
        const firstWorker = await createReceiver('native-stream-1'); activeReceiver = firstWorker;
        coordinator.worker = firstWorker.worker; coordinator.workerEpoch = firstWorker.epoch;
        coordinator.attachTableChannel();
        const oldPost = channel.targets.get(coordinator).post;
        assert.equal(channel.tables.get('actors').streamed.source, issuer);
        await known(firstWorker, message => message.rows.length === 0);
        await wait(() => firstWorker.messages.find(message => message.kind === 'ordinary' && message.rows[0]?.value === 1));
        observations.push('initial_native_null_occurrence_full_knownempty');

        World.user = { sessions: [], revision: 0 };
        const sessions = Array.from({ length: 70 }, (_, i) => member({ locX: i * 5 }));
        const original = sessions[0], id = original.actor.fetchId(); assert.equal(id, FIRST);
        const life = Life.acceptLifecycleRow({ characterId: id, phase: 'cold', activity: 'hunting',
            level: 10, hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 1,
            inventorySummary: JSON.stringify({ 1864: { selfId: 1864, amount: 12 } }) });
        const originalState = Runtime.index.getSource(id, 'state');
        const conserveState = () => {
            assert.equal(Life.cachedState(id), life); assert.equal(Runtime.index.getSource(id, 'state'), originalState);
            assert.equal(originalState.source, life); assert.equal(life.inventory[1864].amount, 12);
        };
        const rows70 = await known(firstWorker, message => message.rows.length === 70);
        assert.equal(rows70.identities >= 70, true); assert.equal(rows70.rawCount, 70); conserveState();
        const prior = rows70.rows.find(row => row.id === id);
        original.actor.setLocXYZ({ locX: 6400, locY: 1, locZ: 2 });
        const moved = await known(firstWorker, message => message.rows.some(row => row.id === id && row.axes.x.value === 6400));
        const movedRow = moved.rows.find(row => row.id === id);
        assert.equal(movedRow.sourceGeneration, prior.sourceGeneration); assert(movedRow.publication > prior.publication);
        assert.equal(moved.rawCount, 69); conserveState();
        // Deliberate invalid wire head; genuine receiver -> table_resync ->
        // actual Coordinator -> channel full recovery. No mocked repair.
        const gap = { name: 'actors', ...moved.chain, pageIndex: 0, transferId: moved.chain.transferId + 1,
            from: moved.version + 2, to: moved.version + 3, full: false, last: 1, rows: [], removed: [] };
        const resyncsBefore = channel.stats.resyncs;
        const gapPayload = { tables: [gap] };
        assert(coordinator.post('table_page', gapPayload, null, Protocol.byteLength(gapPayload) + 1024));
        await wait(() => firstWorker.messages.find(message => message.type === 'table_resync'
            && message.payload.names.includes('actors')));
        const recovered = await known(firstWorker, message => message.rows.length === 70
            && message.chain.copyId > moved.chain.copyId && message.rows.some(row => row.id === id && row.axes.x.value === 6400));
        assert.equal(channel.stats.resyncs, resyncsBefore + 1);
        assert.equal(recovered.rawCount, 69); conserveState();
        observations.push('actual_gap_resync_and_full_recovery');
        World.retireUserActor(original, original.actor);
        const retired = await known(firstWorker, message => message.rows.some(row => row.id === id
            && row.sourceGeneration > movedRow.sourceGeneration));
        const retiredGeneration = retired.rows.find(row => row.id === id).sourceGeneration;
        const retiredToken = World.registeredActorById(id).token;
        original.actor.setLocX(6401);
        await known(firstWorker, message => message.rows.some(row => row.id === id
            && row.sourceGeneration === retiredGeneration && row.axes.x.value === 6401));
        assert.equal(World.registeredActorById(id).token, retiredToken);
        assert.equal(World.registeredActorById(id).retired, true); conserveState();
        const replacement = member({ id, account: original.accountId, locX: 20 });
        const replaced = await known(firstWorker, message => message.rows.some(row => row.id === id
            && row.sourceGeneration > retiredGeneration && row.axes.x.value === 20));
        assert.equal(original.destroyed, true); assert.equal(replaced.rows.length, 70);
        const token = World.registeredActorById(id).token;
        original.actor.setLocXYZ({ locX: 9000, locY: 0, locZ: 0 });
        assert.equal(World.registeredActorById(id).token, token);
        World.removeUser(replacement);
        await known(firstWorker, message => message.rows.length === 69 && message.rows.every(row => row.id !== id));
        conserveState(); observations.push('native_dirty_retired_raw_movement_replacement_late_old_movement_and_current_remove_and_original_state');

        World.user = null;
        const reset = await known(firstWorker, message => message.rows.length === 0 && message.chain.worldGeneration > replaced.chain.worldGeneration);
        const resetCleanup = reset.cleanups.filter(result => result.copyId === reset.chain.copyId
            && result.worldGeneration === reset.chain.worldGeneration);
        assert.deepEqual(resetCleanup.map(result => result.inspected), [64, 5]);
        assert.equal(resetCleanup[0].done, false); assert.equal(resetCleanup[1].done, true);
        assert(reset.cleanups.every(result => result.inspected <= 64 && result.limit === 64));
        assert(reset.unknownWindows > 0); conserveState();
        World.user = { sessions: [], revision: 0 };
        const current = member({ id, locX: 30 });
        await known(firstWorker, message => message.rows.length === 1 && message.rows[0].axes.x.value === 30);
        observations.push('native_reset_new_occurrence_bounded_cleanup_knownempty');

        firstWorker.worker.postMessage({ kind: 'fixture_stop_on_terminal', epoch: firstWorker.epoch });
        await wait(() => firstWorker.messages.find(message => message.kind === 'stop_armed'));
        channel.resync(coordinator, firstWorker.epoch, ['actors']);
        await wait(() => firstWorker.messages.find(message => message.kind === 'actor_stopped'
            && message.cleanupCancelled && message.stateOriginal));

        assert.equal(channel.stopActorRecipient(coordinator, 'wrong-epoch'), false);
        // Actual public stop() BEFORE any started/DB lifecycle path: early fence.
        await coordinator.stop();
        const atStop = sent.length;
        current.actor.setLocXYZ({ locX: 40, locY: 0, locZ: 0 });
        coordinator.attachTableChannel();
        channel.resync(coordinator, firstWorker.epoch, ['actors']); await turn(); await turn();
        assert.equal(sent.length, atStop); assert.equal(channel.actorSnapshot().stopped, true);
        ordinaryRows[0] = { id: 1, value: 2 }; channel.changed('fixture_ordinary', ordinaryRows[0]);
        await wait(() => firstWorker.messages.find(message => message.kind === 'ordinary'
            && message.rows[0]?.value === 2 && !message.actorReady && message.stateOriginal));
        assert.equal(sent.length, atStop);
        observations.push('receiver_queued_cleanup_cancelled_and_ordinary_after_actor_stop');
        const secondWorker = await createReceiver('native-stream-2');
        firstWorker.live = false; activeReceiver = secondWorker;
        coordinator.worker = secondWorker.worker; coordinator.workerEpoch = secondWorker.epoch;
        coordinator.attachTableChannel();
        const restarted = await known(secondWorker, message => message.rows.length === 1 && message.rows[0].axes.x.value === 40);
        assert(restarted.chain.attachmentId > reset.chain.attachmentId);
        const lastPage = sent.findLast(page => page.epoch === secondWorker.epoch);
        assert.equal(oldPost(lastPage.payload, Protocol.byteLength(lastPage.payload)), false);
        const beforeStale = sent.length;
        channel.resync(coordinator, firstWorker.epoch, ['actors']);
        await coordinator.onMessage(Protocol.envelope('table_resync', firstWorker.epoch, { names: ['actors'] }),
            firstWorker.worker, firstWorker.epoch);
        await turn(); await turn();
        assert.equal(sent.length, beforeStale);
        secondWorker.worker.postMessage(Protocol.envelope('table_page', firstWorker.epoch, lastPage.payload, 'fixture:wrong-epoch'));
        await wait(() => secondWorker.messages.find(message => message.kind === 'rejected_epoch'));
        conserveState(); observations.push('exact_stop_sameepoch_no_revive_new_epoch_full_and_stale_source');
        assert(budgets.every(value => value.inspected <= 64 && value.receipts <= 64));
        assert(sent.every(page => page.entries <= 64 && page.declaredBytes <= Protocol.MAX_MESSAGE_BYTES
            && Protocol.byteLength(page.payload) <= page.declaredBytes));
        assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), ['isolated.ini']);
        console.log('OBSERVATIONS ' + JSON.stringify({ observations, pages: sent.length, pumpBudgets: budgets,
            helperWorkers: 2, gameWorker: 0, actualCoordinatorAttachPostEarlyStop: true,
            coordinatorDBStartupClaim: false, realWorkerParentMessagePort: true }));
    } catch (error) {
        console.error('PRIMARY_FAILURE', error);
        throw error;
    } finally {
        if (coordinator && activeReceiver) channel?.stopActorRecipient(coordinator, activeReceiver.epoch);
        channel?.detach(coordinator); channel?.tables.get('actors')?.unsubscribe?.(); issuer?.dispose();
        if (channel && originalPump) channel.pumpActor = originalPump;
        if (coordinator && originalPost) coordinator.post = originalPost;
        if (ordinaryRegistered) channel.tables.delete('fixture_ordinary');
        const exitCodes = [];
        for (const receiver of receivers) {
            receiver.live = false;
            if (!receiver.joined) {
                receiver.worker.postMessage({ kind: 'fixture_stop', epoch: receiver.epoch });
                const done = await Promise.race([receiver.exit, new Promise(resolve => {
                    const timer = setTimeout(() => resolve(null), 2000); receiver.exit.finally(() => clearTimeout(timer));
                })]);
                if (done === null) await receiver.worker.terminate();
            }
            exitCodes.push(await receiver.exit);
        }
        if (coordinator) { coordinator.worker = null; coordinator.workerEpoch = null; }
        const files = fs.readdirSync(directory);
        if (World) World.user = previousUser;
        if (previousPaths) {
            options.default.Database.path = previousPaths.world; options.default.Database.historyPath = previousPaths.history;
            options.default.BotPopulation.knowledgeErrorsEnabled = previousKnowledge;
        }
        for (const key of environmentKeys) {
            if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
        }
        process.chdir(previousCwd); fs.rmSync(directory, { recursive: true, force: true });
        assert.deepEqual(files, ['isolated.ini']); assert.equal(Database?.isReady() === true, false);
        assert.equal(exitCodes.every(code => code === 0), true);
        assert.equal(receivers.every(receiver => receiver.joined), true);
        assert.equal(fs.existsSync(directory), false);
        console.log('CLEANUP ' + JSON.stringify({ workersJoined: receivers.length, files, databaseReady: false,
            bothPathsAbsent: !fs.existsSync(generated.world) && !fs.existsSync(generated.history),
            previousWorldRestored: World?.user === previousUser, directoryRemoved: !fs.existsSync(directory) }));
    }
}

if (isMainThread) main().catch(error => { console.error(error); process.exitCode = 1; });
else childMain();
