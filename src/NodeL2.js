require('./Global');

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

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    utils.infoWarn('DB', 'flushing buffered character state before %s', signal);
    const forceExit = setTimeout(() => process.exit(0), 15000);
    forceExit.unref?.();
    Promise.resolve().then(() => invoke('GameServer/Bot/Population/PopulationService').stop())
        .catch((error) => utils.infoWarn('ColdWorker', 'cold simulation drain failed: %s', error.message))
        .then(() => CharacterWriteQueue.flushAll())
        .catch((error) => utils.infoWarn('DB', 'final buffered flush failed: %s', error.message))
        .then(() => PathfindingWorkerPool.shutdown())
        .then(() => LangfuseTracing.shutdown())
        .then(() => Database.close())
        .catch((error) => utils.infoWarn('DB', 'graceful SQLite close failed: %s', error.message))
        .finally(() => process.exit(0));
}

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
Database.init(() => {
    DataCache.init();
    const stackableItemIds = (DataCache.items || [])
        .filter((item) => item.etc?.stackable === true)
        .map((item) => Number(item.selfId));
    Database.compactStackableInventory(stackableItemIds, 'compact-stackable-inventory-v2').then((result) => {
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
        await World.init();
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        await AfkTrade.init();

        new Server('AuthServer', options.default.AuthServer, (socket) => {
            return new AuthSession(socket);
        });

        new Server('GameServer', options.default.GameServer, (socket) => {
            return new GameSession(socket);
        });

        BotManager.init();
        AfkTrade.matchBotDemand().catch((error) => {
            utils.infoWarn('AfkTrade', 'restored shop matching failed: %s', error.message);
        });
        WorldObserver.init();
        DevConsole.init();
        if (process.env.L2NODE_HOT_LOAD_TEST === '1') {
            invoke('GameServer/Bot/LoadTest/HotBotLoadTest').start();
        }
    });
});
