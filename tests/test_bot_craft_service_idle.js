const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originals = {
    upsertState: LifeState.upsertState,
    craft: ColdCraftingService.craft
};

async function run() {
    const station = {
        characterId: 10027,
        name: 'Tarin10027',
        phase: 'cold',
        activity: 'crafting',
        timing: {},
        stats: {
            generatedIndex: 10027,
            craftStationId: 'resource_components',
            craftShop: { name: 'Maestro Components' },
            equipmentPlan: { status: 'active', strategy: 'craft', recipeId: 598 }
        }
    };
    let saved = null;

    LifeState.upsertState = (state, reason) => {
        saved = { state, reason };
        return Promise.resolve(state);
    };
    ColdCraftingService.craft = () => assert.fail('craft services must not craft for themselves');

    const result = await PopulationService.resolveColdState(station);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.debug.activity, 'craft_service_idle');
    assert.strictEqual(saved.reason, 'craft_service_idle');
    assert.strictEqual(saved.state.stats.equipmentPlan, undefined);
    assert.ok(Number(saved.state.timing.nextResolveAt) > Date.now());
    console.log('Bot craft service idle checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
    LifeState.upsertState = originals.upsertState;
    ColdCraftingService.craft = originals.craft;
});
