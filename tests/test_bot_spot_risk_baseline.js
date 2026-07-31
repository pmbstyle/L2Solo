const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

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
    console.log('Bot spot risk baseline checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(Database, originals);
    LifeState.reset?.();
});
