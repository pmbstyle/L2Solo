const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originals = {
    ensure: SpotProfiles.ensure,
    planFor: GearPlanner.planFor,
    craft: ColdCraftingService.craft,
    upsertState: LifeState.upsertState
};

async function run() {
    const state = {
        characterId: 73,
        name: 'CraftWaitProbe',
        phase: 'cold',
        level: 30,
        activity: 'crafting',
        timing: { nextResolveAt: Date.now() - 1 },
        stats: { equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: 189 } },
        inventory: {}
    };
    let saved = null;

    SpotProfiles.ensure = () => [];
    GearPlanner.planFor = () => state.stats.equipmentPlan;
    ColdCraftingService.craft = () => Promise.resolve({ state, crafted: false, reason: 'materials_changed' });
    LifeState.upsertState = (next, reason) => {
        saved = { state: next, reason };
        return Promise.resolve(next);
    };

    const result = await PopulationService.resolveColdState(state);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(saved.reason, 'cold_craft_wait');
    assert.strictEqual(saved.state.activity, 'hunting', 'a station wait without a ready recipe must resume material farming');
    assert(saved.state.timing.nextResolveAt > Date.now(), 'recovered craft wait must receive a new scheduling deadline');
    console.log('Bot craft wait recovery checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    SpotProfiles.ensure = originals.ensure;
    GearPlanner.planFor = originals.planFor;
    ColdCraftingService.craft = originals.craft;
    LifeState.upsertState = originals.upsertState;
});
