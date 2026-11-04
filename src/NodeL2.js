require('./Global');

// [Perf] live: started before any worker, so the boot is recorded too; without it nothing runs.
invoke('Perf/LiveRecorder').start();

const { acquireDatabaseAccess, verifyUpdateDatabasePaths, rejectUpdateBeforeMigrations, beginUpdateMigrations } = require('../scripts/database-access');
const startupRoot = require('path').resolve(__dirname, '..');
const expectedUpdateDatabases = process.env.L2NODE_UPDATE_TRIAL === '1' && process.env.L2NODE_UPDATE_DATABASES
    ? JSON.parse(process.env.L2NODE_UPDATE_DATABASES) : null;
const configuredDatabase = { ...options.default.Database };
let releaseDatabaseAccess;
try {
    if (expectedUpdateDatabases) {
        const [world, history] = verifyUpdateDatabasePaths(startupRoot, configuredDatabase, expectedUpdateDatabases);
        // Keep the checked physical pair even if an INI file or directory alias
        // changes while the remaining startup modules load.
        options.default.Database ||= {};
        options.default.Database.path = world;
        options.default.Database.historyPath = history;
    }
    releaseDatabaseAccess = acquireDatabaseAccess(require('path').resolve(startupRoot, options.default.Database?.path || 'tmp/nodel2.sqlite'));
    if (expectedUpdateDatabases) {
        verifyUpdateDatabasePaths(startupRoot, configuredDatabase, expectedUpdateDatabases);
        beginUpdateMigrations(startupRoot, expectedUpdateDatabases);
    }
} catch (error) {
    releaseDatabaseAccess?.();
    if (expectedUpdateDatabases) rejectUpdateBeforeMigrations(startupRoot, expectedUpdateDatabases);
    throw error;
}
process.once('exit', releaseDatabaseAccess);

const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
LangfuseTracing.init();

// User imports
const AuthSession = invoke('AuthenticationServer/Session');
const GameSession = invoke('GameServer/Session');
const World       = invoke('GameServer/World/World');
const DataCache   = invoke('GameServer/DataCache');
const Database    = invoke('Database');
const Server      = invoke('Server');
const BotManager  = invoke('GameServer/Bot/BotManager');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const DevConsole = invoke('GameServer/DevConsole');
const WorldObserver = invoke('WorldObserver/WorldObserverServer');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const ClanService = invoke('GameServer/Clan/ClanService');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const PathfindingWorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');

// Shutdown has to finish before the launcher kills the process (SIGKILL at
// 18 s in run-server, 20 s in start). The drains get DRAIN_BUDGET_MS; then
// buffered character state is flushed and the database closed whatever is
// still draining, and the process exits by EXIT_DEADLINE_MS at the latest.
const DRAIN_BUDGET_MS = 10000;
const EXIT_DEADLINE_MS = 16000;
// A patch queued while a flush runs is taken by the next round.
const FINAL_FLUSH_ROUNDS = 3;
// The process backstop counts by site and logs the first of each (the shared failure rule).
const FailureLog = invoke('FailureLog');
const noteFailure = (kind, error) => FailureLog.noteUnnamed(kind, error);

let finalWrites = null;
// The last writes, shared by a clean shutdown and a crash: flush buffered
// character state, then close the database (close does not flush it).
function writeFinalState() {
    finalWrites = finalWrites || (async () => {
        let round = 0;
        do {
            try { await CharacterWriteQueue.flushAll(); }
            catch (error) { utils.infoWarn('DB', 'final buffered flush failed: %s', error.message); }
        } while (CharacterWriteQueue.pendingCount() > 0 && ++round < FINAL_FLUSH_ROUNDS);
        const unsaved = CharacterWriteQueue.pendingCount();
        if (unsaved > 0) utils.infoWarn('DB', 'exit leaves buffered state of %d characters unsaved', unsaved);
        try { await Database.close(); }
        catch (error) { utils.infoWarn('DB', 'graceful SQLite close failed: %s', error.message); }
    })();
    return finalWrites;
}

let exitCode = 0;
function exitAfterFinalWrites() {
    // Exits even if a write hangs; not unref'd, it must fire.
    setTimeout(() => {
        utils.infoWarn('Process', 'final writes did not finish by the exit deadline');
        FailureLog.report();
        process.exit(exitCode);
    }, EXIT_DEADLINE_MS);
}

// Each drain step logs its own failure and the next steps still run. Steps
// left when the budget runs out are named and skipped.
async function drainServices(progress) {
    const steps = [
        ['cold simulation drain', () => invoke('GameServer/Bot/Population/PopulationService').stop()],
        ['pathfinding workers', () => PathfindingWorkerPool.shutdown()],
        ['clan planning worker', () => invoke('GameServer/Clan/ClanPlanningCoordinator').shutdown()],
        ['tracing', () => LangfuseTracing.shutdown()],
        ['interaction memory', async () => {
            const result = await invoke('GameServer/Social/InteractionMemoryRuntime').events.drain();
            if (!result.drained) utils.infoWarn('InteractionMemory', 'shutdown left %d unwritten episodes', result.pending);
        }],
        ['recommendations', () => invoke('GameServer/Recommendations/Runtime').stop()]
    ];
    for (const [name, step] of steps) {
        if (progress.expired) return;
        progress.step = name;
        try { await step(); }
        catch (error) { utils.infoWarn('Shutdown', '%s failed: %s', name, error.message); }
    }
    progress.step = null;
}

let shuttingDown = false;
let updateVerified = process.env.L2NODE_UPDATE_TRIAL !== '1';
let acceptUpdate;
function sessionFactory(Session) {
    return socket => {
        // Ports must bind successfully before an update is accepted, but no
        // player may enter the world until its rollback journal is committed.
        if (!updateVerified) { socket.destroy(); return { dataReceive() {}, error() {} }; }
        return new Session(socket);
    };
}
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    utils.infoWarn('DB', 'flushing buffered character state before %s', signal);
    const started = Date.now();
    exitAfterFinalWrites();
    const progress = { step: null, expired: false };
    const budget = new Promise((resolve) => setTimeout(resolve, DRAIN_BUDGET_MS));
    Promise.race([drainServices(progress), budget]).then(() => {
        if (progress.step) {
            progress.expired = true;
            utils.infoWarn('Shutdown', 'drain budget of %d ms ran out in %s; later steps skipped', DRAIN_BUDGET_MS, progress.step);
        }
        return writeFinalState();
    }).finally(() => {
        utils.infoWarn('Shutdown', 'done in %d ms', Date.now() - started);
        FailureLog.report();
        process.exit(exitCode);
    });
}

// A fatal failure: save what is buffered, then exit with code 1.
function exitAfterFailure() {
    if (exitCode) return;
    exitCode = 1;
    if (shuttingDown) return; // the running shutdown writes and exits with this code
    shuttingDown = true;
    exitAfterFinalWrites();
    writeFinalState().finally(() => {
        FailureLog.report();
        process.exit(exitCode);
    });
}

// Set once every service is up and the ports are opened. Before that any
// failure is fatal: a half-started server holds the save lock with no ports,
// and the launcher would show it running.
let started = false;

// A rejection nobody handles is a bug in its chain: logged and counted, the
// running server keeps going. An uncaught exception leaves the process in an
// unknown state, so it is fatal.
process.on('unhandledRejection', (reason) => {
    noteFailure(started ? 'unhandled rejection' : 'unhandled rejection during startup', reason);
    if (!started) exitAfterFailure();
});
process.on('uncaughtException', (error) => {
    noteFailure('uncaught exception', error);
    exitAfterFailure();
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (message) => {
    if (message?.type === 'shutdown') shutdown(message.reason || 'IPC');
    if (message?.type === 'launcher:update-commit') { updateVerified = true; acceptUpdate?.(); }
});
process.on('disconnect', () => { if (!updateVerified) shutdown('update_launcher_disconnected'); });

console.info('\n\
    + ================================== \n\
    # Server Name: ......... NodeL2      \n\
    # Build Revision: ...... %s          \n\
    # Chronicle: ........... C4 [656]    \n\
    # Build date: .......... %s          \n\
    # NodeJS version: ...... %s          \n\
    + ================================== \n\
', utils.buildNumber(), utils.currentDate(), utils.nodeVersion());
console.info(
    'Progress   :: preset %s | exp x%s | sp x%s | adena x%s | drop x%s | spoil x%s',
    ProgressionRates.profile().preset,
    ProgressionRates.profile().exp,
    ProgressionRates.profile().sp,
    ProgressionRates.profile().adena,
    ProgressionRates.profile().drop,
    ProgressionRates.profile().spoil
);

// Startup procedure, init `World` & `Data`, then `AuthServer`, finally `GameServer`
async function startServer() {
    DataCache.init();
    invoke('GameServer/Clan/ClanPlanningCoordinator').start();
    const stackableItemIds = (DataCache.items || [])
        .filter((item) => item.etc?.stackable === true)
        .map((item) => Number(item.selfId));
    await Database.compactStackableInventory(stackableItemIds, 'compact-stackable-inventory-v3').then((result) => {
        if (!result.skipped && result.rowsRemoved > 0) {
            utils.infoSuccess('DB', 'compacted stackable inventory groups=%d rows=%d', result.groups, result.rowsRemoved);
            return Database.reclaimUnusedSpace();
        }
        return { reclaimed: false, reason: result.skipped ? 'compaction_already_complete' : 'no_rows_removed' };
    }).catch((error) => {
        utils.infoWarn('DB', 'failed to compact or reclaim stackable inventory: %s', error.message);
        return { reclaimed: false, reason: 'maintenance_failed' };
    }).then((result) => {
        if (result.reclaimed) {
            utils.infoSuccess('DB', 'reclaimed unused SQLite space pages=%d bytes=%d', result.freePages, result.reclaimedBytes);
        }
    }).then(() => ClanService.init()).then(async () => {
        GeodataEngine.init();
        invoke('GameServer/Geodata/NpcInteractionGeometry').init();
        await World.init();
        await invoke('GameServer/Recommendations/Runtime').start();
        await invoke('GameServer/ClanHall/Runtime').start();
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        await AfkTrade.init();
        // Every bot's persona before any bot decides (BotPersona.of).
        await invoke('GameServer/Bot/AI/BotPersona').loadAll().then((count) => {
            utils.infoSuccess('BotPersona', 'loaded %d personas', count);
        }).catch((error) => utils.infoWarn('BotPersona', 'persona load failed: %s', error.message));

        invoke('GameServer/Knowledge/RecipeCatalog').warmup();
        invoke('GameServer/World/Generics/NativeKnowledgeBase').warmup();

        new Server('AuthServer', options.default.AuthServer, sessionFactory(AuthSession));

        new Server('GameServer', options.default.GameServer, sessionFactory(GameSession));

        BotManager.init();
        if (process.env.L2NODE_UPDATE_TRIAL === '1' && process.connected) {
            process.send({ type: 'launcher:initialized' }, () => {});
            await new Promise(resolve => { if (updateVerified) resolve(); else acceptUpdate = resolve; });
        }
        if (process.env.L2NODE_LAUNCHER_STATUS === '1' && process.send) {
            const { population } = require('../scripts/launcher-population');
            const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
            const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');
            const PlayerActivity = invoke('GameServer/Bot/Population/PlayerActivitySignal');
            const PopulationConfig = invoke('GameServer/Bot/Population/PopulationConfig');
            const report = () => {
                if (shuttingDown || !process.connected) return;
                process.send({ type: 'launcher:population', ...population({
                    states: LifeState.populationSeedStates(), botSessions: BotManager.sessions || [],
                    playerSessions: World.user?.sessions || [], isStaticService: Identity.isStaticService,
                    isRealPlayerSession: PlayerActivity.isRealPlayerSession,
                    botCapacity: PopulationConfig.enabled ? PopulationConfig.maxPlayingPopulation : 0
                }) }, () => {});
            };
            report();
            const statusTimer = setInterval(report, 2000);
            statusTimer.unref();
            process.once('disconnect', () => clearInterval(statusTimer));
        }
        WorldObserver.init();
        DevConsole.init();
        // A window run's hot scenario (scripts/perf/window.js); nothing without L2NODE_PERF_SCENARIO=hot.
        invoke('Perf/HotCrowd').start();
        started = true;
    });
}

// A startup step that throws or rejects stops the server (see `started`).
Database.init(() => startServer().catch((error) => {
    noteFailure('startup failure', error);
    exitAfterFailure();
}));
