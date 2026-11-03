require('./Global');

const { acquireDatabaseAccess } = require('../scripts/database-access');
const releaseDatabaseAccess = acquireDatabaseAccess(require('path').resolve(
    __dirname, '..', options.default.Database?.path || 'tmp/nodel2.sqlite'
));
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
// Distinct failure reasons kept for counting; later ones share one bucket.
const MAX_FAILURE_REASONS = 64;

const failureReasons = new Map();
// One failure site is one reason: the error's name and first stack frame
// (messages often carry ids). The first of each is logged with its stack,
// repeats are only counted and summed up at exit.
function noteFailure(kind, error) {
    const lines = String(error?.stack || error?.message || error).split('\n');
    const site = error?.stack ? `${error.name || 'Error'} ${(lines[1] || '').trim()}` : lines[0].slice(0, 160);
    let key = `${kind}: ${site}`;
    if (!failureReasons.has(key) && failureReasons.size >= MAX_FAILURE_REASONS) key = `${kind}: other reasons`;
    const count = (failureReasons.get(key) || 0) + 1;
    failureReasons.set(key, count);
    if (count === 1) {
        utils.infoWarn('Process', '%s (repeats are counted, not logged): %s', kind, error?.stack || error);
    }
}

function reportFailureCounts() {
    for (const [key, count] of failureReasons) {
        if (count > 1) utils.infoWarn('Process', '%s x%d', key, count);
    }
}

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
        reportFailureCounts();
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
        reportFailureCounts();
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
        reportFailureCounts();
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
});

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

        new Server('AuthServer', options.default.AuthServer, (socket) => {
            return new AuthSession(socket);
        });

        new Server('GameServer', options.default.GameServer, (socket) => {
            return new GameSession(socket);
        });

        BotManager.init();
        WorldObserver.init();
        DevConsole.init();
        if (process.env.L2NODE_HOT_LOAD_TEST === '1') {
            invoke('GameServer/Bot/LoadTest/HotBotLoadTest').start();
        }
        started = true;
    });
}

// A startup step that throws or rejects stops the server (see `started`).
Database.init(() => startServer().catch((error) => {
    noteFailure('startup failure', error);
    exitAfterFailure();
}));
