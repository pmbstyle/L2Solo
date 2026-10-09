'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Craft = invoke('GameServer/Bot/Economy/CraftShopService');
const Decision = invoke('GameServer/Bot/Economy/WealthCraftDecision');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const recipe = Recipes.resolve(1786);
const state = { characterId: 900003, phase: 'cold', activity: 'hunting', level: 5,
    classId: 53, adena: 100000, inventory: {}, vitals: { mp: 1000 },
    stats: { classId: 53, money: [1000, .001, 0, 0] } };
const context = { hourAdena: 1000, moneyPrice: .001, mpPerHour: 100000, maxBatches: 1 };
const options = { unknownRecipes: () => [recipe], staticExits: () => [],
    offersFor: id => id === recipe.productId ? [{ ownerId: 2, price: 1000, count: 1, town: 'Giran' }] : [],
    planPurchase: (owner, id, count) => ({ town: 'Giran', units: count, whole: true,
        cost: count, landed: count, lines: [{ line: { lineId: id, selfId: id, revision: 1 }, count, price: 1 }],
        tripDetails: { hours: 0, fees: 0 } }) };
assert.equal(Craft.canCraft(state, recipe), true);
assert.equal(Decision.eligible(state), true);
const chosen = Decision.chooseOpportunity(state, [], context, options);
assert(chosen, 'an affordable profitable unknown recipe reaches ordinary production admission');
assert.equal(chosen.learning, true);
assert.equal(chosen.recipe.recipeId, recipe.recipeId);
assert(chosen.basket.purchases.some(row => row.selfId === recipe.recipeItemId && row.count === 1),
    'the production basket acquires a real scroll before learning');
const learned = Decision.chooseOpportunity(state, [recipe.recipeId], context, options);
assert(learned);
assert.equal(learned.learning, false);
assert(!learned.basket.purchases.some(row => row.selfId === recipe.recipeItemId), 'a known recipe is not purchased twice');
for (const denied of [{ ...state, level: 4 }, { ...state, craftLevel: 0 },
    { ...state, classId: 0, stats: { ...state.stats, classId: 0 } }]) {
    assert.equal(Decision.eligible(denied), false);
    assert.equal(Decision.chooseOpportunity(denied, [], context, options), null);
}
assert.equal(Decision.chooseOpportunity({ ...state, adena: 0 }, [], context, options), null,
    'capability does not bypass funding');
assert.equal(Decision.chooseOpportunity(state, [], context, { ...options,
    planPurchase: () => null }), null, 'capability does not invent physical recipe/material supply');
assert.equal(Decision.eligible({ ...state, stats: { ...state.stats, craftStationId: 'fixed' } }), false);
console.log('PASS beginner native skill -> unknown recipe basket / known book / funding / physical supply / station boundary');
