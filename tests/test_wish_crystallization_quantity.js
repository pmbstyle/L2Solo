'use strict';
const assert = require('node:assert/strict');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const price = 44540, crystals = 5375, yieldPerShield = 33;
function build({ owned = 0, incoming = 0, crystalStock = 0, wallet = 2000000, secondGoal = false } = {}) {
    const gear = (id, amount, valueHours, slot) => [
        { key: `power:${id}:${slot}`, need: 'power', progressionPriority: 1, valueHours,
            object: { itemId: id, slot }, paths: [{ requirements: [{ key: `item:${id}`, amount: 1 }] }] },
        { key: `item:${id}`, paths: [{ kind: 'luxury_exchange', activity: 'improving', itemId: id,
            quoted: true, improvement: { itemId: id, materials: [{ selfId: 1458, amount }] },
            grossRequirements: [{ key: 'item:1458', amount }] }] }
    ];
    const nodes = [...gear(95, crystals, 100, 14), ...(secondGoal ? gear(2429, 160, 10, 12) : []),
        { key: 'item:1458', paths: [{ kind: 'crystallize', activity: 'improving', itemId: 1458,
            productCount: yieldPerShield, batchLimit: 3, availableUnits: 99,
            improvement: { sourceSelfId: 626 }, grossRequirements: [{ key: 'item:626', amount: 1 }] }] },
        { key: 'item:626', price, paths: [{ kind: 'buy', activity: 'shopping', itemId: 626,
            price, quoted: true, executable: true, availableUnits: 3 }] }];
    return new WishNetwork().build({ actorKey: 'bounded-crystals', inputKey: 'fresh', nodes,
        roots: ['power:95:14', ...(secondGoal ? ['power:2429:12'] : [])],
        stockFor: id => id === 626 ? { owned, incoming } : id === 1458 ? { owned: crystalStock } : {},
        wallet, hourAdena: 100000, persona: { traits: { commitment: 0 } }, remembered: false });
}
const crystalPlan = result => result.plans.get('power:95:14').requirements[0].plan.requirements[0].plan;
let result = build({ owned: 2 });
assert.equal(result.queue[0].price, (Math.ceil(crystals / yieldPerShield) - 2) * price,
    'the whole C item costs 163 shields less the two physical spares, rather than a three-shield batch');
assert.equal(result.queue[0].funded, false, 'two million cannot fund the complete Poleaxe path');
assert.equal(crystalPlan(result).batches, 163, 'forecast includes enough whole batches for all 5375 crystals');
assert.equal(crystalPlan(result).requirements[0].amount, 161);
assert.equal(result.activity.kind, 'crystallize', 'physical spares advance the goal without another purchase');
assert.equal(result.activity.improvement.amount, 2);
assert.equal(result.activity.amount, 66);
assert.equal(result.activity.price, 0);
assert.equal(result.activity.valueHours, 100 * 66 / crystals, 'a partial batch earns only its share of the full benefit');

result = build({ wallet: 10000000 });
assert.equal(result.queue[0].price, 163 * price);
assert.equal(result.activity.itemId, 626);
assert.equal(result.activity.amount, 3, 'the next purchase respects the finite native batch');
assert.equal(result.activity.price, 3 * price, 'command cost remains the real cost of the three ordered shields');
assert.equal(result.activity.valueHours, 100 * 99 / crystals);
const advert = Intent.project({}, result, {}, () => price).find(row => row.itemId === 626);
assert.equal(advert.amount, 3, 'public input demand cannot order the entire future 163-shield supply');
assert.equal(advert.valueHours, result.activity.valueHours);

result = build({ incoming: 2, wallet: 10000000 });
assert.equal(result.queue[0].price, 161 * price, 'accepted incoming lowers cash still needed');
assert.equal(result.activity.kind, 'buy', 'accepted incoming never proves physical crystallization readiness');
assert.equal(result.activity.amount, 1, 'only the missing input of the bounded command is ordered');
assert.equal(result.activity.price, price);

result = build({ crystalStock: 66, wallet: 10000000 });
assert.equal(crystalPlan(result).batches, 161, 'completed crystallization reduces the full remaining requirement');
assert.equal(result.queue[0].price, 161 * price);
assert.equal(result.activity.amount, 3);
result = build({ crystalStock: crystals });
assert.equal(result.activity.kind, 'luxury_exchange', 'only all physical crystals admit the final C exchange');
assert.equal(result.activity.itemId, 95);

result = build({ owned: 2, secondGoal: true });
const boots = result.queue.find(row => row.object.itemId === 2429);
assert.equal(boots.price, 3 * price, 'the smaller C goal is independently priced against shared physical stock');
assert(boots.funded, 'the genuinely affordable C piece can be funded');
assert(!result.queue.find(row => row.object.itemId === 95).funded);
assert.equal(result.activity.rootKey, boots.key, 'a cheap first batch cannot steal priority for the expensive weapon');
assert.equal(result.activity.improvement.amount, 2);
console.log('Crystallization quantities: full C cost, bounded commands, physical readiness, incoming stock and shared gear priority passed');

// MeatShield had 631 physical crystals after breaking a bow, yet competing
// equipment roots claimed them and selected another crystal purchase.
function continuation(complete = true, urgent = false) {
    const gear = (id, amount) => [
        { key: `power:${id}:9`, need: 'power', progressionPriority: 2, valueHours: 10,
            object: { itemId: id, slot: 9 }, paths: [{ requirements: [{ key: `item:${id}`, amount: 1 }] }] },
        { key: `item:${id}`, paths: [{ kind: 'luxury_exchange', activity: 'improving', itemId: id,
            improvement: { itemId: id }, grossRequirements: [{ key: 'item:1458', amount }] }] }
    ];
    const nodes = [...gear(397, 475), ...gear(608, 310),
        { key: 'power:2387:11', need: 'power', progressionPriority: 2, valueHours: 10,
            object: { itemId: 2387, slot: 11 }, paths: [{ requirements: [{ key: 'item:2387', amount: 1 }] }] },
        { key: 'item:2387', paths: [{ kind: 'craft', activity: 'crafting',
            grossRequirements: [{ key: 'item:1458', amount: 295 }, { key: 'item:1885', amount: 1 }] }] },
        { key: 'item:1885', paths: [{ kind: 'drop', activity: 'hunting', itemId: 1885, costHours: 5 }] },
        { key: 'item:1458', paths: [{ kind: 'buy', activity: 'shopping', price: 2419,
            itemId: 1458, quoted: true, availableUnits: 10000 }] },
        ...(urgent ? [{ key: 'stock:shots', need: 'power', progressionPriority: 4, valueHours: 100,
            paths: [{ kind: 'buy', activity: 'shopping', itemId: 1464, price: 100 }] }] : [])];
    return new WishNetwork().build({ actorKey: 'crystal-continuation', inputKey: 'after-native-break',
        completionKey: 'power:608:9', nodes, roots: ['power:2387:11', 'power:397:9', 'power:608:9', ...(urgent ? ['stock:shots'] : [])],
        stockFor: id => ({ owned: id === 1458 ? complete ? 631 : 100 : 0 }),
        wallet: 30000000, hourAdena: 500000, persona: { traits: { commitment: 0 } }, remembered: false });
}
result = continuation();
assert.equal(result.activity.kind, 'luxury_exchange', 'native crystallization finishes its funded C exchange before another crystal purchase');
assert.equal(result.activity.itemId, 608);
assert.equal(continuation(false).activity.kind, 'buy', 'a continuation cannot manufacture missing physical crystals');
// Below its line the kit is weighed with the gear it serves, in one tier: no tier of its own.
assert.equal(continuation(true, true).queue.find(wish => wish.key === 'stock:shots')?.progressionPriority, 2,
    'urgent stock joins the gear\'s tier');
console.log('PASS crystallization continuation / physical readiness / urgent stock');
