const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');
const World = invoke('GameServer/World/World');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');

const originalUser = World.user;
const originalTickBudgeted = PopulationService.tickBudgeted;
const originalBackgroundResolverEnabled = Config.backgroundResolverEnabled;
const originalBackgroundPartyEnabled = Config.backgroundPartyEnabled;
const originalPhasePolicyEnabled = Config.phasePolicyEnabled;
const originalMaxPlayingPopulation = Config.maxPlayingPopulation;
const originalCoordinatorStart = ColdSimulationCoordinator.start;
const originalCoordinatorStop = ColdSimulationCoordinator.stop;
const originalDirectorStart = Director.start;
const originalDirectorStop = Director.stop;
const originalSchedulePersonaBackfill = PopulationService.schedulePersonaBackfill;
const originalInitialized = PopulationService.initialized;
const originalStarted = PopulationService.started;

try {
    Config.backgroundResolverEnabled = true;
    Config.backgroundPartyEnabled = false;
    Config.phasePolicyEnabled = false;
    Config.maxPlayingPopulation = 0;
    PlayerActivitySignal.reset();

    const player = {
        constructor: { name: 'Session' },
        accountId: 'player_telemetry',
        actor: { fetchIsOnline: () => true }
    };
    const companion = {
        constructor: { name: 'BotSession' },
        accountId: 'bot_companion_telemetry',
        actor: { fetchIsOnline: () => true },
        partyCompanion: true,
        followPlayerSession: player
    };
    World.user = { sessions: [player, companion] };

    let legacySchedulerCalls = 0;
    let coordinatorStarts = 0;
    PopulationService.tickBudgeted = () => {
        legacySchedulerCalls += 1;
        throw new Error('legacy main-thread cold scheduler must remain unused');
    };
    ColdSimulationCoordinator.start = () => {
        coordinatorStarts += 1;
        return Promise.resolve(true);
    };
    ColdSimulationCoordinator.stop = () => ({ stopped: true });
    Director.start = () => {};
    Director.stop = () => {};
    PopulationService.schedulePersonaBackfill = () => {};
    PopulationService.initialized = true;
    PopulationService.started = false;

    PopulationService.start();
    const profile = Metrics.snapshot().scheduler;
    assert.strictEqual(coordinatorStarts, 1, 'cold lifecycle must still start through the worker coordinator');
    assert.strictEqual(typeof PopulationService.schedulerTimer, 'object',
        'the population lifecycle must assign a telemetry-only scheduler timer');
    const scheduler = Metrics.snapshot().scheduler;
    assert.strictEqual(profile.playerMode, 'party', 'telemetry must observe the connected real-player party');
    assert.strictEqual(scheduler.playerMode, 'party');
    assert.strictEqual(scheduler.realPlayers, 1);
    assert.strictEqual(scheduler.companions, 1);
    assert.strictEqual(legacySchedulerCalls, 0, 'telemetry refresh must not invoke the legacy cold scheduler');
    console.log('Bot population scheduler telemetry checks passed');
} finally {
    if (PopulationService.started) PopulationService.stop();
    World.user = originalUser;
    PopulationService.tickBudgeted = originalTickBudgeted;
    Config.backgroundResolverEnabled = originalBackgroundResolverEnabled;
    Config.backgroundPartyEnabled = originalBackgroundPartyEnabled;
    Config.phasePolicyEnabled = originalPhasePolicyEnabled;
    Config.maxPlayingPopulation = originalMaxPlayingPopulation;
    ColdSimulationCoordinator.start = originalCoordinatorStart;
    ColdSimulationCoordinator.stop = originalCoordinatorStop;
    Director.start = originalDirectorStart;
    Director.stop = originalDirectorStop;
    PopulationService.schedulePersonaBackfill = originalSchedulePersonaBackfill;
    PopulationService.initialized = originalInitialized;
    PopulationService.started = originalStarted;
    PlayerActivitySignal.reset();
}
