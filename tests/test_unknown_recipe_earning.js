'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Decision = require('../src/GameServer/Bot/Economy/WealthCraftDecision');
const Policy = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const recipe = Recipes.resolveByRecipeId(79);
assert(recipe && recipe.recipeItemId);
const state = { characterId: 900003, phase: 'cold', activity: 'hunting', level: 60,
    adena: 100000, vitals: { mp: 1000 }, inventory: {}, stats: { classId: 57, money: [1000, .001, 0, 0] } };
const trip = () => 0; trip.details = () => ({ hours: 0, fees: 0 });
const context = { hourAdena: 1000, moneyPrice: .001, mpPerHour: 100000, maxBatches: 1, trip };
let scrollPrice = 10, inputAvailable = true, buyerAvailable = true;
const options = { unknownRecipes: () => [recipe],
    staticExits: () => [], offersFor: id => id === recipe.productId && buyerAvailable
        ? [{ ownerId: 2, price: 1000, count: 1, town: 'Giran' }] : [],
    planPurchase: (owner, id, n) => inputAvailable ? { town: 'Giran', units: n, whole: true,
        cost: n * (id === recipe.recipeItemId ? scrollPrice : 1), landed: n * (id === recipe.recipeItemId ? scrollPrice : 1),
        lines: [{ line: { lineId: id, revision: 1 }, count: n, price: id === recipe.recipeItemId ? scrollPrice : 1 }],
        tripDetails: { hours: 0, fees: 0 } } : null };
let chosen = Decision.chooseOpportunity(state, [], context, options);
assert(chosen?.learning, 'empty book and level60 can earn from an unknown D recipe');
assert.equal(Decision.chooseOpportunity({ ...state, phase: 'hot' }, [], context, options).valueHours, chosen.valueHours,
    'visible/far actor projections share the same pure recipe valuation');
assert.equal(chosen.basket.purchases.find(row => row.selfId === recipe.recipeItemId).count, 1);
scrollPrice = 2000;
assert.equal(Decision.chooseOpportunity(state, [], context, options), null, 'scroll must repay its own price');
scrollPrice = 10; inputAvailable = false;
assert.equal(Decision.chooseOpportunity(state, [], context, options), null, 'cannot manufacture missing input supply');
inputAvailable = true; buyerAvailable = false;
assert.equal(Decision.chooseOpportunity(state, [], context, options), null, 'do not invent a buyer');
buyerAvailable = true;
assert.equal(Decision.chooseOpportunity(state, [], context, { ...options,
    planPurchase: (owner, id, n) => id === recipe.recipeItemId ? null : options.planPurchase(owner, id, n) }), null,
    'missing scroll supply does not become an imagined acquisition');
assert.equal(Decision.chooseOpportunity(state, [], context, { ...options,
    planPurchase: (owner, id, n) => ({ ...options.planPurchase(owner, id, n), landed: 2010,
        tripDetails: { hours: 0, fees: 2000 } }) }), null, 'cash travel fees can make the recipe uneconomic');
assert.equal(Decision.chooseOpportunity({ ...state, craftLevel: 0 }, [], context, options), null);
const other = Recipes.resolveByRecipeId(80);
const competing = Decision.chooseOpportunity(state, [{ recipeId: other.recipeId }], context, { ...options,
    offersFor: id => id === other.productId ? [{ ownerId: 2, price: 10000, count: 1, town: 'Giran' }] : options.offersFor(id) });
assert.equal(competing.recipe.recipeId, other.recipeId, 'the more valuable learned route beats unknown recipe acquisition');
const owned = { ...state, inventory: { [recipe.recipeItemId]: { selfId: recipe.recipeItemId, amount: 1 } } };
chosen = Decision.chooseOpportunity(owned, [], { ...context, independentPrice: () => 2000 }, options);
assert.equal(chosen, null, 'learning consumes the owned scroll sale opportunity');
const known = Decision.chooseOpportunity(state, [{ recipeId: recipe.recipeId }], context, options);
assert(known && !known.learning);
assert(!known.basket.purchases.some(row => row.selfId === recipe.recipeItemId), 'known recipes pay no scroll twice');
const basket = Policy.basketFor(recipe, (id, n) => ({ town: 'Giran', whole: true, units: n, cost: n, landed: n + 250,
    tripDetails: { hours: .2, fees: 50 } }), () => null, 3,
    { ...context, recipeInput: recipe.recipeItemId });
assert.equal(basket.purchases.find(row => row.selfId === recipe.recipeItemId).count, 1, 'one scroll for three crafts');
assert.equal(basket.actualCashFees, 50); assert.equal(basket.travelHours, .2, 'scroll and inputs share the town trip');
const ids = Object.values(Recipes.loadRecipeItems()).filter(row => row.type === 'dwarven').map(row => row.recipeId);
const packed = Codec.pack(ids);
assert(Buffer.byteLength(packed) <= 128);
assert.deepEqual(Codec.unpack(packed).map(row => row.recipeId), [...new Set(ids)].sort((a, b) => a - b));
assert.equal(Codec.unpack('broken'), null);
assert.deepEqual(Codec.unpack(Codec.pack([])), []);
console.log('PASS unknown D recipe income, purchase cost, owned value, supply, one-time shared trip and full book codec');
