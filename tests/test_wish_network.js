const assert = require('node:assert/strict');
const { WishNetwork, moneyQueue } = require('../src/GameServer/Bot/Economy/WishNetwork');

const queue = moneyQueue([
    { key: 'sword', price: 100, valueHours: 10 },
    { key: 'armor', price: 200, valueHours: 15 },
    { key: 'gift', price: 10, valueHours: 0.5 }
], 250, 50);
assert.deepEqual(queue.queue.map(wish => wish.funded), [true, false, false]);
assert.equal(queue.moneyPrice, 15 / 200);
assert.equal(queue.available, 100, 'smaller wishes cannot consume money held at the first gap');
assert.equal(moneyQueue(queue.queue, 1000, 50).moneyPrice, 0, 'rich actors need no second free-money purse');

const network = new WishNetwork();
const input = {
    actorKey: 'character:1', inputKey: 'level30:bag1:board1', wallet: 250, survivalReserve: 50,
    hourAdena: 100, playedHours: 10, persona: { traits: { commitment: 0.5 } },
    previous: { focus: ['sword', 5, 100], dormant: [] }, roots: ['sword', 'status', 'care', 'scores'],
    nodes: [
        { key: 'sword', need: 'power', object: 1, valueHours: 10, price: 100,
            paths: [
                { kind: 'board', activity: 'shopping', price: 100, costHours: 1 },
                { kind: 'craft', activity: 'crafting', costHours: 0.1, requirements: [{ key: 'ore', amount: 2 }] }
            ] },
        { key: 'status', need: 'status', object: 'known crafter', valueHours: 2, price: 100,
            paths: [{ activity: 'crafting', costHours: 1, requirements: [{ key: 'ore', amount: 1 }] }] },
        { key: 'care', need: 'care', object: 'friend', valueHours: 1, price: 10,
            paths: [{ activity: 'helping', costHours: 1, requirements: [{ key: 'ore', amount: 1 }] }] },
        { key: 'scores', need: 'scores', object: 'rival', valueHours: 1, price: 10,
            paths: [{ activity: 'pvp', costHours: 1, riskHours: 1 }] },
        { key: 'ore', object: 10, paths: [{ activity: 'hunting', costHours: 0.25 }] }
    ]
};
const first = network.build(input);
assert.equal(first.plans.get('sword').kind, 'craft', 'cost-up compares complete alternative paths');
assert.equal(first.plans.get('sword').effort, 0.6);
assert.equal(first.focus[0], 'sword');
assert.equal(first.focus[1], 5, 'loyal focus retains its original age');
assert.equal(first.demands.get('ore'), 6.5, 'shared means sum value per required unit without multiplying the root value');
assert.equal(first.queue[0].key, 'sword');
assert(first.activity && first.valuePerHour > 0);
assert.equal(network.build(input), first, 'unchanged event input reuses the derived network');
assert.notEqual(network.build({ ...input, inputKey: 'level30:bag2:board1' }), first);
assert.notEqual(network.build({ ...input, actorKey: 'clan:1' }), first, 'clan uses the same engine with its own wallet');
assert.throws(() => network.build({ ...input, inputKey: 'cycle', roots: ['sword'], nodes: [
    { key: 'sword', need: 'power', valueHours: 1, paths: [{ requirements: [{ key: 'sword' }] }] }
] }), /cyclic_wish_network/);
assert.throws(() => network.build({ ...input, inputKey: 'missing', roots: ['sword'], nodes: [
    { key: 'sword', need: 'power', valueHours: 1, paths: [{ requirements: [{ key: 'missing' }] }] }
] }), /missing_wish_requirement/);
assert.throws(() => network.build({ ...input, inputKey: 'too-large', nodes: Array.from({ length: 41 }, (_, i) => ({ key: String(i) })) }),
    /invalid_wish_network_input/);
console.log('wish network core: PASS (one queue, four needs, path cost, shared demand, focus, event cache and group reuse)');

const funding = network.build({ actorKey: 'funding', inputKey: 'gap', wallet: 50, hourAdena: 100,
    roots: ['big', 'small'], nodes: [
        { key: 'big', need: 'power', valueHours: 10, price: 100, paths: [{ activity: 'shopping', price: 100 }] },
        { key: 'small', need: 'care', valueHours: 0.1, price: 10, paths: [{ activity: 'shopping', price: 10 }] }
    ], moneyPaths: [{ activity: 'hunting', incomePerHour: 100 }] });
assert.equal(funding.activity.funding, true, 'smaller purchases cannot steal the first-gap money');
assert.equal(funding.activity.shortfall, 50);
assert.equal(first.valuePerHour, 10 / .6, 'whole requirement cost prices the focused progress hour');
const stock = network.build({ actorKey: 'stock', inputKey: 'quantity', wallet: 1000, hourAdena: 100,
    roots: ['shots'], nodes: [
        { key: 'shots', need: 'power', valueHours: 2, price: 100, paths: [{ requirements: [{ key: 'item', amount: 10 }] }] },
        { key: 'item', object: 1, paths: [{ activity: 'shopping', price: 10 }] }
    ] });
assert.equal(stock.activity.amount, 10);
assert.equal(stock.activity.price, 100, 'funded leaf spends the complete required quantity');
console.log('wish funding, complete progress hour and acquisition quantity: PASS');
