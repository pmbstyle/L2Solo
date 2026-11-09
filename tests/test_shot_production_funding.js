'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
invoke('GameServer/DataCache').init({ validate: false });
const Shots = require('../src/GameServer/Bot/Economy/ShotProductionFunding');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const Wealth = require('../src/GameServer/Bot/Economy/WealthCraftDecision');
const Recipes = invoke('GameServer/Items/C4RecipeItems');

const state = { characterId: 910901, level: 37, adena: 300000, inventory: {},
    stats: { classId: 56, money: [1000, .001, 20000, 0] } };
const context = { hourAdena: 1000, moneyPrice: .001 };
const route = (profit, type = 'listing', productId = 1464) => ({
    recipe: Recipes.resolveByProductId(productId), valueHours: profit * context.moneyPrice,
    exit: { type, conditional: false },
    basket: { cashCost: 100000, actualCashFees: 0, cost: 100000 },
    valuation: { expectedReceipts: 100000 + profit, expectedResidual: 0 }
});

const thin = route(25000);
assert.equal(Funding.spendable(state, 0, { r: thin.valueHours / thin.basket.cashCost }), 0,
    'ordinary craft retains its original funding threshold');
assert(Shots.canFund(state, thin, context), 'a 25% shot return can fund its physical inputs');
assert.equal(Shots.canFund(state, route(14999), context), false, 'forecast keeps its 15% buffer');
assert(Shots.canFund(state, route(15000), context), 'exact forecast margin is admitted');
assert(Shots.canFund(state, route(1, 'afk'), context), 'a backed order needs positive net gain');
assert.equal(Shots.canFund(state, route(0, 'afk'), context), false);
assert.equal(Shots.canFund(state, route(-1, 'afk'), context), false);
assert.equal(Shots.canFund({ ...state, adena: 119999 }, thin, context), false,
    'survival cash cannot finance production');
const protectedState = { ...state, stats: { ...state.stats, money: [1000, .001, 20000, 0, .01, 200000, 99] } };
assert.equal(Shots.canFund(protectedState, thin, context), false, 'higher-priority wishes retain their cash');
const remoteSale = { ...thin, valuation: { ...thin.valuation, cashNow: 110000 } };
assert.equal(Shots.investment(remoteSale,context).cash,110000,'the initial delivery trip is part of the funded cash');
assert.equal(Shots.canFund({...state,adena:120000},remoteSale,context),false,
    'input cash alone cannot pay the seller trip beside the survival reserve');
const remoteRecipe = Shots.recipePaths({...state,adena:135000},remoteSale.recipe,
    {route:remoteSale,acquisition:{available:true,price:1},context});
assert.equal(remoteRecipe.best.purchaseCap,5000,'recipe repricing protects the full production and delivery cash');
assert.equal(Shots.investment(route(25000, 'listing', 1881), context), null,
    'the exception cannot fund other crafted goods');

for (const id of [1464, 2511, 3949]) {
    const output = route(40000, 'listing', id), recipe = output.recipe;
    const options = { route: output, acquisition: { available: true, price: 10000 }, context };
    assert.equal(Wealth.recipePaths(state, recipe, options).best.kind, 'hold',
        'the shared recipe rule still requires its original finite allowance');
    const learned = Shots.recipePaths(state, recipe, options);
    assert.equal(learned.best.kind, 'acquire', 'shots cover the scroll from their positive finite net gain');
    assert.equal(learned.best.valueHours, 30, 'recipe cash is deducted exactly once');
    assert.equal(learned.best.funding.r, .001 + 30 / 110000);
    assert.equal(learned.best.purchaseCap, 21739, 'a repriced scroll cannot exceed its finite margin');
    assert.equal(Shots.recipePaths({ ...state, adena: 129999 }, recipe, options).best.kind, 'hold',
        'the whole scroll and input investment must fit beside the survival reserve');
    assert.equal(Shots.recipePaths(state, recipe, { ...options,
        acquisition: { available: true, price: 30000 } }).best.kind, 'hold',
    'a recipe which removes the forecast margin stays unpurchased');
    assert.equal(Shots.recipePaths(state, recipe, { ...options,
        acquisition: { available: true, price: 10000, fees: 10000, hours: 10 } }).best.kind, 'hold',
    'recipe travel and fees are real costs too');
}
console.log('PASS shot-only funding: finite margin, scroll investment, cash and priority protection');
