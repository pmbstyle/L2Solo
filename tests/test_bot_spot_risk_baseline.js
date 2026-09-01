const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');

DataCache.init();

const originals = {
    execute: Database.execute,
    syncInventorySummary: Database.syncInventorySummary,
    updateCharacterLocation: Database.updateCharacterLocation,
    updateCharacterExperience: Database.updateCharacterExperience,
    updateCharacterVitals: Database.updateCharacterVitals
};

async function run() {
    Database.execute = () => Promise.resolve([]);
    Database.syncInventorySummary = () => Promise.resolve();
    Database.updateCharacterLocation = () => Promise.resolve();
    Database.updateCharacterExperience = () => Promise.resolve();
    Database.updateCharacterVitals = () => Promise.resolve();

    const state = {
        characterId: 992,
        name: 'RiskBaselineProbe',
        level: 20,
        phase: 'cold',
        activity: 'hunting',
        spotId: 'old_spot',
        adena: 0,
        exp: 0,
        sp: 0,
        loc: {},
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: {},
        inventory: {},
        stats: {
            deaths: 4,
            fightsResolved: 20,
            classId: 0,
            classProgressionLevel: 20,
            classProgressionClassId: 0,
            spotRisk: { spotId: 'old_spot', deathsAtEntry: 1, fightsAtEntry: 2 }
        }
    };
    const saved = await LifeState.applyResolve(state, {
        patch: {
            activity: 'hunting',
            spotId: 'new_spot',
            vitals: state.vitals,
            // The resolver patch mirrors the prior state, including the old
            // baseline. The lifecycle must replace it for the new spot.
            stats: { ...state.stats, coldCombat: { cooldowns: {} } }
        },
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: 2000,
        debug: { fights: 2, wins: 1 }
    });

    assert.strictEqual(saved.stats.spotRisk.spotId, 'new_spot');
    assert.strictEqual(saved.stats.spotRisk.deathsAtEntry, 4);
    assert.strictEqual(saved.stats.spotRisk.fightsAtEntry, 20);
    assert.strictEqual(saved.stats.spotRisk.version, SpotRiskPolicy.RISK_WINDOW_VERSION);
    assert.strictEqual(saved.stats.spotRisk.windowFights, 2);
    assert.strictEqual(saved.stats.spotRisk.windowWins, 1);
    assert.strictEqual(saved.stats.spotRisk.windowDeaths, 0);

    const weakWindow = SpotRiskPolicy.recordResolve(saved.stats.spotRisk, {
        spotId: 'new_spot', timestamp: 3000, totalDeaths: 4, totalFights: 22, totalWins: 1,
        fights: SpotRiskPolicy.RISK_WINDOW_FIGHTS - 2, wins: 2, deaths: 0
    });
    const lowWinState = {
        ...saved,
        spotId: 'new_spot',
        stats: { ...saved.stats, spotRisk: weakWindow }
    };
    const lowWinPressure = SpotRiskPolicy.deathPressure(lowWinState);
    assert.strictEqual(lowWinPressure.reason, 'low_win_rate',
        'a short low-win window must replan without waiting for cumulative deaths');
    assert.strictEqual(lowWinPressure.fights, SpotRiskPolicy.RISK_WINDOW_FIGHTS);
    const lowWinBackoff = SpotRiskPolicy.backoffForStates([lowWinState], 'new_spot', 3000);
    assert.strictEqual(lowWinBackoff.reason, 'low_win_rate',
        'the backoff must preserve whether combat performance, rather than deaths, caused it');
    const frozenWeakWindow = SpotRiskPolicy.recordResolve(weakWindow, {
        spotId: 'new_spot', timestamp: 3500, totalDeaths: 4, totalFights: 34, totalWins: 3,
        fights: 4, wins: 4, deaths: 0
    });
    assert.deepStrictEqual(frozenWeakWindow, weakWindow,
        'a failed sample must stay bounded and stable until routing consumes it');

    const healthyWindow = SpotRiskPolicy.recordResolve({}, {
        spotId: 'healthy_spot', timestamp: 4000, totalDeaths: 0, totalFights: 0, totalWins: 0,
        fights: SpotRiskPolicy.RISK_WINDOW_FIGHTS, wins: SpotRiskPolicy.RISK_WINDOW_FIGHTS - 1, deaths: 0
    });
    const rolledWindow = SpotRiskPolicy.recordResolve(healthyWindow, {
        spotId: 'healthy_spot', timestamp: 5000, totalDeaths: 0,
        totalFights: SpotRiskPolicy.RISK_WINDOW_FIGHTS, totalWins: SpotRiskPolicy.RISK_WINDOW_FIGHTS - 1,
        fights: 3, wins: 0, deaths: 0
    });
    assert.strictEqual(rolledWindow.windowFights, 3,
        'a healthy completed sample must roll into a fresh bounded window');

    const migratedWindow = SpotRiskPolicy.recordResolve({
        spotId: 'legacy_spot', deathsAtEntry: 0, fightsAtEntry: 0
    }, {
        spotId: 'legacy_spot', timestamp: 6000, totalDeaths: 40, totalFights: 10000, totalWins: 7000,
        fights: 4, wins: 0, deaths: 0
    });
    assert.deepStrictEqual(
        [migratedWindow.windowFights, migratedWindow.windowWins, migratedWindow.windowDeaths],
        [4, 0, 0],
        'a legacy lifetime baseline must migrate into a fresh bounded combat window'
    );
    const firstBackoff = SpotRiskPolicy.withBackoff(state, {
        spotId: 'old_spot',
        reason: 'death_pressure',
        startedAt: 1000,
        until: 1000 + SpotRiskPolicy.BACKOFF_MS
    }, 1000);
    const repeatedBackoff = SpotRiskPolicy.withBackoff(firstBackoff, {
        spotId: 'old_spot',
        reason: 'death_pressure',
        startedAt: firstBackoff.stats.spotBackoffs[0].until + 1
    }, firstBackoff.stats.spotBackoffs[0].until + 1);
    assert.strictEqual(repeatedBackoff.stats.spotBackoffs[0].attempts, 2,
        'returning to the same lethal spot must escalate its persistent backoff');
    assert(repeatedBackoff.stats.spotBackoffs[0].until
        >= firstBackoff.stats.spotBackoffs[0].until + 1 + SpotRiskPolicy.BACKOFF_MS * 2,
    'a repeated death loop must stay excluded longer than the first occurrence');
    const legacyUntil = 2000 + SpotRiskPolicy.BACKOFF_MS;
    const legacyRepeatedBackoff = SpotRiskPolicy.withBackoff({
        ...state,
        stats: {
            ...state.stats,
            spotBackoffs: [{
                spotId: 'legacy_spot',
                reason: 'death_pressure',
                startedAt: 2000,
                until: legacyUntil
            }]
        }
    }, {
        spotId: 'legacy_spot',
        reason: 'death_pressure',
        startedAt: legacyUntil + 1
    }, legacyUntil + 1);
    assert.strictEqual(legacyRepeatedBackoff.stats.spotBackoffs[0].attempts, 2,
        'a persisted pre-attempts backoff must count as the first failed visit');
    assert(legacyRepeatedBackoff.stats.spotBackoffs[0].until
        >= legacyUntil + 1 + SpotRiskPolicy.BACKOFF_MS * 2,
    'returning after a legacy backoff must use the second-attempt duration');
    const overCapTimestamp = legacyRepeatedBackoff.stats.spotBackoffs[0].until + 1;
    const cappedBackoff = SpotRiskPolicy.withBackoff(legacyRepeatedBackoff, {
        spotId: 'over_cap_spot',
        reason: 'death_pressure',
        startedAt: overCapTimestamp,
        until: overCapTimestamp + SpotRiskPolicy.MAX_BACKOFF_MS * 2
    }, overCapTimestamp);
    assert.strictEqual(cappedBackoff.stats.spotBackoffs[0].until,
        overCapTimestamp + SpotRiskPolicy.MAX_BACKOFF_MS,
        'a persisted deadline must not extend a spot backoff beyond the maximum duration');
    console.log('Bot spot risk baseline checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(Database, originals);
    LifeState.reset?.();
});
