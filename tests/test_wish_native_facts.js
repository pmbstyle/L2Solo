'use strict';
// Task 2: the wish network reads native craft and farm facts. Draws per native
// command, stockless child cost per batch (E192), held units at exit value,
// one trip per town, root priority against free stock, cold missing materials.
const assert = require('node:assert/strict');
require('../src/Global');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const { capture } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
function build(nodes, roots, stockFor) {
    return new WishNetwork().build({ actorKey: 'facts', inputKey: 'fresh', nodes, roots, stockFor,
        wallet: 10000, hourAdena: 100, persona: { traits: { commitment: 0 } }, remembered: false });
}
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const rootFor = (id, valueHours, key, amount = 1) => ({ key: `power:${id}:7`, need: 'power', valueHours,
    object: { itemId: id }, paths: [{ requirements: [{ key, amount }] }] });
const buy = (id, price, extra = {}) => ({ key: `item:${id}`, price, paths: [{ kind: 'buy', activity: 'shopping', price,
    itemId: id, executable: true, quoted: true, availableUnits: 1000, ...extra }] });
const craft = (id, gross, extra = {}) => ({ key: `item:${id}`, price: 500, paths: [{ kind: 'craft', activity: 'crafting',
    costHours: .01, itemId: id, recipeId: id, productCount: 1, grossRequirements: gross, ...extra }] });

// Draws: a cold command of three batches draws once (5 batches -> 2 draws);
// a hot bot draws per batch. Consumed inputs are not repeatable here, so the
// chance stays a chance (no until-success price).
const scarce = buy(202, 2, { repeatable: false });
const drawn = perCommand => {
    const product = craft(101, [{ key: 'item:202', amount: 1 }], { successProbability: .5, perCommand });
    const root = rootFor(101, 100, 'item:101', 5);
    return [build([root, product, scarce], [root.key], () => ({})).plans.get(root.key),
        build([root, product, scarce], [root.key]).plans.get(root.key)];
};
for (const plan of drawn(3)) near(plan.successProbability, .25, 'cold: five batches in commands of three draw twice');
for (const plan of drawn(1)) near(plan.successProbability, .5 ** 5, 'hot: one draw per batch');
for (const plan of drawn(64)) near(plan.successProbability, .5, 'workshop or cold capacity: one command');

// E192: a stockless craft child of two per batch needed four times is two
// batches of its inputs, not four.
{
    const product = craft(101, [{ key: 'item:202', amount: 10 }], { productCount: 2 });
    const root = rootFor(101, 100, 'item:101', 4);
    const plan = build([root, product, buy(202, 2)], [root.key]).plans.get(root.key);
    assert.equal(plan.price, 40, 'two batches x ten inputs x 2 adena');
}

// Held units are worth their exit value (Q1 A), never the belief price.
{
    const held = { ...buy(202, 5), exitValue: 1 };
    const root = rootFor(301, 100, 'item:202', 4);
    const plan = build([root, held], [root.key], id => id === 202 ? { owned: 4 } : {}).plans.get(root.key);
    assert.equal(plan.price, 0);
    near(plan.effort, 4 * 1 / 100, 'four held units at exit value 1, in the bot hours');
}

// Farm trips: two farmed items on the same far spot's town pay one trip.
{
    const farm = id => ({ key: `item:${id}`, price: 10, paths: [{ kind: 'drop', activity: 'hunting', itemId: id,
        costHours: 1, town: 'Dion', tripHours: 2, tripFees: 50 }] });
    const root = { key: 'power:401:7', need: 'power', valueHours: 100, object: { itemId: 401 },
        paths: [{ requirements: [{ key: 'item:402', amount: 1 }, { key: 'item:403', amount: 1 }] }] };
    const plan = build([root, farm(402), farm(403)], [root.key]).plans.get(root.key);
    near(plan.hours, 1 + 1 + 2, 'two farm hours and one trip');
    assert.equal(plan.price, 50, 'trip fees once');
}

// Priority: each root alone against all free stock. A craft root whose ten
// inputs are held is free; it claims them before a dearer root that would
// otherwise rank first by its stockless (purchase) price.
{
    const material = buy(202, 2);
    const cheap = craft(501, [{ key: 'item:202', amount: 10 }]);
    const dear = craft(502, [{ key: 'item:202', amount: 10 }, { key: 'item:503', amount: 1 }]);
    const small = rootFor(501, 30, 'item:501'), large = rootFor(502, 100, 'item:502');
    const result = build([small, large, cheap, dear, material, buy(503, 40)], [large.key, small.key],
        id => id === 202 ? { owned: 10 } : {});
    assert.equal(result.plans.get(small.key).price, 0, 'the held-input root keeps its own stock');
    assert.equal(result.plans.get(large.key).price, 60, 'the other root buys ten inputs and its own part');
}

// Cold decision: missing materials are the prepared remaining amounts (stock
// and incoming subtracted once), not the gross recipe rows.
{
    const product = craft(101, [{ key: 'item:202', amount: 10 }], { productCount: 2 });
    const root = rootFor(101, 100, 'item:101', 5);
    const network = build([root, product, buy(202, 2)], [root.key], id => id === 202 ? { owned: 4, incoming: 2 } : {});
    const decision = capture({ inputKey: 'facts', network }, { characterId: 1, inventory: { 202: { selfId: 202, amount: 4 } }, stats: {} });
    assert.deepEqual(decision.materials, [[202, 24]], 'three batches x ten minus four held and two incoming');
}
console.log('test_wish_native_facts: ok');
