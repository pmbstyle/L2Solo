'use strict';
// The economy model's crafter capacity: shot demand against the seated MP of
// crafter twins, from the game's recipe and regeneration data.
const assert = require('node:assert/strict');
const Boot = require('../scripts/economy-model/boot');
const Capacity = require('../scripts/economy-model/capacity');

Boot.boot('x1');
const world = Capacity.gameWorld();

// Soulshot D: 3 Soul Ore + 1 D crystal give 156 shots for 40 MP (C4 recipe data).
const ssd = world.recipe(1463);
assert.equal(ssd.productCount / ssd.mpCost, 3.9, 'SSD crafts per MP from the recipe row');
const one = Capacity.bandDemand({ lo: 30, hi: 30, population: 1 }, { 9: 1 }, 0, {
    ...world, hour: () => ({ shotId: 1463, shots: 3900 })
});
assert.ok(Math.abs(one.mp - 1000) < 1e-9, '3900 SSD an hour take 1000 MP');
assert.ok(Math.abs(one.crystals.get(1458) - 25) < 1e-9, 'and 25 D crystals (1 per 156 shots)');

// An Artisan at 30 regenerates 5818 MP an hour seated.
const artisan = world.twin(30);
assert.equal(artisan.classId, 56);
assert.ok(Math.abs(artisan.mp / 5818 - 1) < 0.01, `Artisan-30 seated MP/h ${artisan.mp}`);
assert.equal(world.twin(40).classId, 57, 'a twin is a Warsmith from 40');

// A two-class fixture: line 1 fires 400 of shot 10 an hour, line 2 100 of shot 20.
const recipes = {
    10: { productCount: 100, mpCost: 50, level: 2, materials: [{ selfId: 99, amount: 1 }, { selfId: 1458, amount: 2 }] },
    20: { productCount: 50, mpCost: 100, level: 2, materials: [] }
};
// The twin seats 1000 MP an hour at level 20 and 3000 at 21 (mean 2000).
const fixture = (createItem = () => 2) => ({
    crystalIds: new Set([1458]),
    hour: line => (line === '1' ? { shotId: 10, shots: 400 } : { shotId: 20, shots: 100 }),
    recipe: id => recipes[id] || null,
    twin: level => ({ classId: 56, mp: level === 20 ? 1000 : 3000, createItem: createItem(level) })
});
const weights = { 1: 1, 2: 1 };
const band = population => ({ lo: 20, hi: 21, population });
const base = Capacity.bandDemand(band(100), weights, 0.1, fixture());
assert.ok(Math.abs(base.mp - 20000) < 1e-9, '20000 shot 10 (10000 MP) + 5000 shot 20 (10000 MP)');
assert.ok(Math.abs(base.ores.get(99) - 200) < 1e-9, 'ore per craft');
assert.ok(Math.abs(base.crystals.get(1458) - 400) < 1e-9, 'crystals per craft');
assert.ok(Math.abs(base.twinsNeeded - 10) < 1e-9, '20000 MP over the mean seated MP of the band levels (2000): 10 twins nonstop');
assert.ok(Math.abs(base.coverage - 1) < 1e-9, '5 twins at 1000 plus 5 at 3000 hold 20000 MP');

// Demand is linear in population and in the hunting share; coverage is capped at 1.
const double = Capacity.bandDemand(band(200), weights, 0.1, fixture());
assert.ok(Math.abs(double.mp - 2 * base.mp) < 1e-9, 'twice the bots, twice the MP');
assert.ok(Math.abs(double.products[0].units - 2 * base.products[0].units) < 1e-9, 'twice the shots');
assert.ok(Math.abs(double.coverage - base.coverage) < 1e-9, 'twins grow with the bots: same coverage');
const hunting = Capacity.bandDemand(band(100), weights, 0.1, fixture(), 0.2);
assert.ok(Math.abs(hunting.mp - 0.2 * base.mp) < 1e-9, 'a fifth of the hour hunting, a fifth of the MP');
assert.equal(hunting.coverage, 1, 'coverage is at most 1');

// A twin whose Create Item level is under the band's recipes crafts nothing.
const young = Capacity.bandDemand(band(100), weights, 0.1, fixture(level => (level === 21 ? 1 : 2)));
assert.ok(Math.abs(young.coverage - 0.25) < 1e-9, 'only the level-20 twins (5 x 1000 of 20000 MP) can craft');

// Crystals through NPC gear: the cheapest per crystal, taxed and untaxed apart.
const routes = Capacity.crystalRoutes([
    { itemId: 1, price: 22990, ref: 20900, crystalId: 1458, crystals: 38 },
    { itemId: 2, price: 30000, ref: 19000, crystalId: 1458, crystals: 38 },
    { itemId: 3, price: 100, ref: 100, crystalId: 1458, crystals: 0 }
]);
assert.equal(routes.get(1458).taxed.perCrystal, 605);
assert.equal(routes.get(1458).taxed.itemId, 1);
assert.equal(routes.get(1458).untaxed.itemId, 2, 'untaxed reads the reference price');
const costs = Capacity.bandCosts(base, { npc: id => (id === 99 ? 300 : 0), ref: () => 10, routes });
assert.equal(costs.oreAdena, 200 * 300);
assert.ok(Math.abs(costs.crystalAdena.taxed - 400 * 605) < 1e-9);
assert.ok(Math.abs(costs.perShot[0].taxed - (300 + 2 * 605) / 100) < 1e-9, 'craft cost per shot');

console.log('PASS economy model crafter capacity');
