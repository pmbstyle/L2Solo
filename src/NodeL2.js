require('./Global');

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
    ClanService.init().then(() => {
        GeodataEngine.init();
        World.init();

        new Server('AuthServer', options.default.AuthServer, (socket) => {
            return new AuthSession(socket);
        });

        new Server('GameServer', options.default.GameServer, (socket) => {
            return new GameSession(socket);
        });

        BotManager.init();
        WorldObserver.init();
        DevConsole.init();
    });
});
