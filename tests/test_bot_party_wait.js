const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originals = {
    ensure: SpotProfiles.ensure,
    planFor: GearPlanner.planFor,
    upsertState: LifeState.upsertState,
    partyWaitReplanMs: Config.partyWaitReplanMs
};

async function run() {
    Config.partyWaitReplanMs = 5 * 60 * 1000;
    const state = {
        characterId: 9101,
        name: 'PartyWaitProbe',
        phase: 'cold',
        level: 30,
        activity: 'hunting',
        spotId: 'cruma',
        timing: { nextResolveAt: Date.now() - 1 },
        stats: {},
        party: {},
        inventory: {}
    };
    let saved = null;
    SpotProfiles.ensure = () => [];
    GearPlanner.planFor = () => ({
        status: 'active',
        requiresParty: true,
        next: { spotId: 'cruma' },
        strategy: 'farm'
    });
    LifeState.upsertState = (next, reason) => {
        saved = { state: next, reason };
        return Promise.resolve(next);
    };

    const result = await PopulationService.resolveColdState(state);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(saved.reason, 'acquisition_party_wait');
    assert.strictEqual(saved.state.activity, 'party_wait');
    assert.strictEqual(saved.state.stats.restUntil, null, 'party wait must not pretend to be HP/MP recovery');
    assert(saved.state.stats.partyWaitUntil >= Date.now() + Config.partyWaitReplanMs - 1000);
    assert.strictEqual(saved.state.timing.nextResolveAt, saved.state.stats.partyWaitUntil, 'only the rare replan deadline belongs to the cold queue');
    console.log('Bot party wait scheduling checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    SpotProfiles.ensure = originals.ensure;
    GearPlanner.planFor = originals.planFor;
    LifeState.upsertState = originals.upsertState;
    Config.partyWaitReplanMs = originals.partyWaitReplanMs;
});
