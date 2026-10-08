process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');

require('./helpers/databaseIsolation');
require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');
const World = invoke('GameServer/World/World');

// Native ActorModel/World publication follows test_n62_visibility_index.
// This isolated fixture creates no database rows, cold claims or World timers.
const ActorModel = invoke('GameServer/Model/Actor');
const publishedSessions = new Set();
let fixtureWorld;
function clearPublishedSessions() {
    // Disconnect the whole old scene before removing its registrations: no
    // still-connected peer should receive an unrelated clan UI update here.
    for (const session of publishedSessions) session.actor.setIsOnline(false);
    for (const session of publishedSessions) World.removeUser(session);
    publishedSessions.clear();
}
function publishSessions(sessions) {
    clearPublishedSessions();
    if (!fixtureWorld) {
        fixtureWorld = { sessions: [], revision: 0 };
        World.user = fixtureWorld;
    }
    for (const session of sessions) {
        session.actor.session = session;
        World.insertUser(session);
        session.actor.setIsOnline(true);
        publishedSessions.add(session);
    }
}
function presenceSession(characterId, accountId, receive, clanId = 0, locX = 0) {
    const session = { accountId, fetchAccountId() { return this.accountId; },
        socket: { write() {}, destroy() {} }, dataSendToMe: receive,
        dataSendToMeAndOthers() {}, dataSendToOthers() {} };
    session.actor = new ActorModel({ id: characterId, name: accountId, username: accountId,
        title: '', level: 20, classId: 0, clanId, clanPrivileges: 0,
        locX, locY: 0, locZ: 0, hp: 100, maxHp: 100, isOnline: false });
    session.actor.session = session;
    return session;
}

const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');

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
const originalClanEventStart = ClanActionService.startEvents;
const originalClanEventStop = ClanActionService.stopEvents;
const originalClanActions = PopulationService.resolveClanActions;
const originalInitialized = PopulationService.initialized;
const originalStarted = PopulationService.started;

async function main() {
try {
    Config.backgroundResolverEnabled = true;
    Config.backgroundPartyEnabled = false;
    Config.phasePolicyEnabled = false;
    Config.maxPlayingPopulation = 0;
    PlayerActivitySignal.reset();

    const player = {
        constructor: { name: 'Session' },
        ...presenceSession(8000010, 'player_telemetry', () => {})
    };
    const companion = {
        constructor: { name: 'BotSession' },
        ...presenceSession(8000011, 'bot_companion_telemetry', () => {}),
        partyCompanion: true,
        followPlayerSession: player
    };
    publishSessions([player, companion]);

    let legacySchedulerCalls = 0;
    let coordinatorStarts = 0;
    let clanEventStarts = 0;
    let clanActionRuns = 0;
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
    // This lifecycle fixture exercises the real telemetry timer and registry,
    // while unrelated clan SQL consumers remain explicit unit dependencies.
    ClanActionService.startEvents = () => { clanEventStarts += 1; };
    ClanActionService.stopEvents = () => {};
    PopulationService.resolveClanActions = () => {
        clanActionRuns += 1;
        return Promise.resolve({ skipped: true, reason: 'telemetry_fixture' });
    };
    PopulationService.initialized = true;
    PopulationService.started = false;

    PopulationService.start();
    // Drain the genuine registry's initial clan_actions job before restoring
    // its dependency; no SQL callback should outlive this fixture.
    await Promise.all([...PopulationService.backgroundJobRegistry.jobs.values()]
        .map(job => job.promise).filter(Boolean));
    assert.strictEqual(clanEventStarts, 1, 'native lifecycle still requests clan event startup');
    assert(PopulationService.backgroundJobRegistry.jobs.has('clan_actions'),
        'the native named job remains registered');
    assert.strictEqual(clanActionRuns, 1, 'the initial native registry tick calls the explicit clan dependency');
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
    clearPublishedSessions();
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
    ClanActionService.startEvents = originalClanEventStart;
    ClanActionService.stopEvents = originalClanEventStop;
    PopulationService.resolveClanActions = originalClanActions;
    PopulationService.initialized = originalInitialized;
    PopulationService.started = originalStarted;
    PlayerActivitySignal.reset();
}

}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
