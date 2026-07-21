const assert = require('assert');

require('../src/Global');

const CraftTelemetry = invoke('GameServer/Bot/Economy/CraftTelemetry');

const iron = { selfId: 1869, name: 'Iron Ore', amount: 3 };
const state = { name: 'Noren', inventory: { 1869: { selfId: 1869, amount: 1 } } };
const initial = {
    status: 'active', strategy: 'craft', recipeId: 598,
    target: { selfId: 245, name: 'Blue Wolf Breastplate' },
    materials: [iron], next: { itemId: 1869, spotId: 'stone-golem-field' }, expectedKills: 30
};

const started = CraftTelemetry.planEvents(state, null, initial);
assert.strictEqual(started[0].type, 'gear_acquisition_started');
assert.strictEqual(started[0].meta.nextItemId, 1869);

const progress = CraftTelemetry.progressEvents(state, initial, {
    ...state,
    inventory: { 1869: { selfId: 1869, amount: 3 } }
});
assert.strictEqual(progress[0].type, 'craft_material_progress');
assert.strictEqual(progress[0].meta.gained, 2);
assert.strictEqual(progress[0].meta.required, 3);

const next = {
    ...initial,
    materials: [iron, { selfId: 1870, name: 'Coal', amount: 2 }],
    next: { itemId: 1870, spotId: 'coal-field' }
};
const advanced = CraftTelemetry.planEvents(state, initial, next);
assert.strictEqual(advanced[0].type, 'craft_material_complete');
assert.strictEqual(advanced[0].meta.completedItemId, 1869);
assert.strictEqual(advanced[0].meta.nextItemId, 1870);

const ready = CraftTelemetry.planEvents(state, initial, { ...initial, status: 'ready_to_craft', next: null });
assert.strictEqual(ready[0].type, 'craft_materials_ready');

const component = CraftTelemetry.planEvents(state, initial, { ...initial, status: 'component_ready', next: null });
assert.strictEqual(component[0].type, 'craft_component_ready');
assert(component[0].summary.includes('intermediate resource'), 'component readiness must not be reported as final equipment readiness');

const travel = CraftTelemetry.stationTravelEvent({ ...state, stats: { equipmentPlan: initial } }, { stationId: 'resource_core', reason: 'component_craft' });
assert.strictEqual(travel.type, 'craft_station_travel');
assert.strictEqual(travel.meta.stationId, 'resource_core');

console.log('Bot craft telemetry checks passed');
