require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('bot-spot-risk-native');
const assert = require('assert');

require('../src/Global');
fixture.assertConfigured(options.default);
process.once('exit', () => require('node:fs').rmSync(fixture.directory, { recursive: true, force: true }));

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');

DataCache.init();

const originals = {
    reconcileBotClanMembership: Database.reconcileBotClanMembership,
    reconcileBotClanGoals: Database.reconcileBotClanGoals,
    execute: Database.execute,
    syncInventorySummary: Database.syncInventorySummary,
    updateCharacterLocation: Database.updateCharacterLocation,
    updateCharacterProgress: Database.updateCharacterProgress
};

async function run() {
    Database.init();
    assert(Database.isReady());
    await Database.createAccount('bot_risk_baseline_fixture', 'fixture');
    // Match the risk contract's character992/level20/XP0/SP0 and empty bag.
    // Its real schema row permits the native lifecycle save; learning is not added.
    await Database.execute([
        `INSERT INTO characters(id, username, name, classId, race, level, hp, maxHp, mp, maxMp,
            exp, sp, sex, face, hair, hairColor, locX, locY, locZ)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [992, 'bot_risk_baseline_fixture', 'RiskBaselineProbe', 0, 0, 20, 100, 100, 50, 50,
            0, 0, 0, 0, 0, 0, 0, 0, 0]
    ], 'fixture:physical-risk-character');
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
    // The bot's saved cold row: a step's class training checks the saved row
    // it was planned from (revision and save time).
    const seeded = await LifeState.upsertState(state);
    assert.strictEqual(seeded?.phase, 'cold', 'fixture: the cold row is saved');
    Database.reconcileBotClanMembership = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.execute = () => Promise.resolve([]);
    Database.syncInventorySummary = () => Promise.resolve();
    Database.updateCharacterLocation = () => Promise.resolve();
    Database.updateCharacterProgress = () => Promise.resolve();

    const saved = await LifeState.applyResolve(seeded, {
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
    // Spot marks live the holder's own steps (stats.stepCount), not a clock.
    const atStep = (value, stepCount) => ({ ...value, stats: { ...value.stats, stepCount } });
    const firstBackoff = SpotRiskPolicy.withBackoff(atStep(state, 0), {
        spotId: 'old_spot', reason: 'death_pressure', startedAt: 1000, steps: SpotRiskPolicy.BACKOFF_STEPS
    }, 1000);
    const firstEnd = firstBackoff.stats.spotBackoffs[0].untilStep;
    assert(SpotRiskPolicy.excludedSpotIdsForStates([atStep(firstBackoff, firstEnd - 1)]).has('old_spot'),
        'a death mark excludes its spot during its steps');
    assert(!SpotRiskPolicy.excludedSpotIdsForStates([atStep(firstBackoff, firstEnd)]).has('old_spot'),
        'a death mark is forgotten after its steps');
    const repeatedBackoff = SpotRiskPolicy.withBackoff(atStep(firstBackoff, firstEnd), {
        spotId: 'old_spot', reason: 'death_pressure', startedAt: 5000
    }, 5000);
    assert.strictEqual(repeatedBackoff.stats.spotBackoffs[0].attempts, 2,
        'returning to the same lethal spot must escalate its persistent backoff');
    assert(repeatedBackoff.stats.spotBackoffs[0].untilStep - firstEnd > firstEnd,
        'a repeated death loop must stay excluded longer than the first occurrence');
    const legacyRepeatedBackoff = SpotRiskPolicy.withBackoff(atStep({ ...state, stats: { ...state.stats,
        spotBackoffs: [{ spotId: 'legacy_spot', reason: 'death_pressure', startedAt: 2000, untilStep: 7 }] } }, 7), {
        spotId: 'legacy_spot', reason: 'death_pressure', startedAt: 9000
    }, 9000);
    assert.strictEqual(legacyRepeatedBackoff.stats.spotBackoffs[0].attempts, 2,
        'a persisted pre-attempts backoff must count as the first failed visit');
    assert.strictEqual(legacyRepeatedBackoff.stats.spotBackoffs[0].untilStep - 7, SpotRiskPolicy.BACKOFF_STEPS * 2,
        'returning after a legacy backoff must use the second-attempt duration');
    const cappedBackoff = SpotRiskPolicy.withBackoff(atStep({ ...state, stats: { ...state.stats,
        spotBackoffs: [{ spotId: 'over_cap_spot', reason: 'death_pressure', startedAt: 11000, attempts: 9, untilStep: 30 }] } }, 40), {
        spotId: 'over_cap_spot', reason: 'death_pressure', startedAt: 12000,
        untilStep: 40 + SpotRiskPolicy.MAX_BACKOFF_STEPS * 2
    }, 12000);
    assert.strictEqual(cappedBackoff.stats.spotBackoffs[0].attempts, 10);
    assert.strictEqual(cappedBackoff.stats.spotBackoffs[0].untilStep - 40, SpotRiskPolicy.MAX_BACKOFF_STEPS,
        'a tenth visit and a copied longer mark both stop at the maximum duration');

    // A saved mark of the former clock becomes steps once, when its row loads:
    // the minutes it had left are steps of the holder's counter.
    const loadedAt = 1_000_000;
    const loaded = SpotRiskPolicy.marksInSteps({ stepCount: 3,
        spotBackoffs: [{ spotId: 'clock_spot', startedAt: 1, until: loadedAt + 5 * 60000 },
            { spotId: 'old_clock_spot', startedAt: 1, until: loadedAt - 1 }],
        coldCompetition: { avoid: { spotId: 'avoided_spot', until: loadedAt + 10 * 60000 } } }, loadedAt);
    assert.deepStrictEqual([...SpotRiskPolicy.excludedSpotIdsForStates([{ stats: loaded }])].sort(),
        ['avoided_spot', 'clock_spot'], 'a loaded clock mark with time left still excludes its spot');
    assert.deepStrictEqual(loaded.spotBackoffs.map(entry => entry.spotId), ['clock_spot'], 'an expired clock mark is dropped');
    assert.deepStrictEqual([...SpotRiskPolicy.excludedSpotIdsForStates([{ stats: { ...loaded, stepCount: 3 + 5 } }])].sort(),
        ['avoided_spot'], 'five minutes left last five steps');
    assert.deepStrictEqual([...SpotRiskPolicy.excludedSpotIdsForStates([{ stats: { ...loaded, stepCount: 3 + 10 } }])], [],
        'ten minutes of avoid last ten steps');
    // The exclusion version: the excluded set names it, and the first mark's
    // end is known ahead (untilStep), so a reader holding a result over the
    // set re-reads on a mark added, removed or expired, and only then.
    const version = stats => SpotRiskPolicy.exclusionVersion({ stats });
    const held = version(loaded);
    assert.deepStrictEqual(held, { revision: 'avoided_spot,clock_spot', untilStep: 8 },
        'the set and the step its first mark ends');
    assert.deepStrictEqual(version({ ...loaded }), held, 'unchanged marks: the same version');
    assert.deepStrictEqual(version({ ...loaded, stepCount: 8 }), { revision: 'avoided_spot', untilStep: 13 },
        'at untilStep the mark ends and the revision moves');
    const added = SpotRiskPolicy.withBackoff({ stats: loaded }, { spotId: 'other_spot', startedAt: 1 }).stats;
    assert.notEqual(version(added).revision, held.revision, 'a mark added moves it');
    assert.equal(version({ ...loaded, spotBackoffs: [] }).revision, 'avoided_spot', 'a mark removed moves it');
    assert.deepStrictEqual(SpotRiskPolicy.exclusionVersion({}), { revision: '', untilStep: Infinity }, 'no marks: none ends');
    const reloaded = LifeState.acceptLifecycleRow({ characterId: 993, name: 'ClockMarkProbe', phase: 'cold',
        activity: 'hunting', spotId: 'other_spot', simulationRevision: 1, updatedAt: 1,
        statsJson: JSON.stringify({ stepCount: 7, spotBackoffs: [{ spotId: 'row_spot', startedAt: 1, until: Date.now() + 2 * 60000 }] }) });
    assert(SpotRiskPolicy.excludedSpotIdsForStates([reloaded]).has('row_spot'), 'a saved row is converted where it becomes a state');
    assert(!SpotRiskPolicy.excludedSpotIdsForStates([atStep(reloaded, 7 + 2)]).has('row_spot'),
        'the converted mark counts the bot\'s own steps');
    console.log('Bot spot risk baseline checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(async () => {
    Object.assign(Database, originals);
    LifeState.reset?.();
    await Database.close();
});
