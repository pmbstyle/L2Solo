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
assert(first.activity && first.hourAdena === input.hourAdena);
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
assert.equal(first.hourAdena, 100, 'repeatable income prices the hour independently of funded wishes');
const stock = network.build({ actorKey: 'stock', inputKey: 'quantity', wallet: 1000, hourAdena: 100,
    roots: ['shots'], nodes: [
        { key: 'shots', need: 'power', valueHours: 2, price: 100, paths: [{ requirements: [{ key: 'item', amount: 10 }] }] },
        { key: 'item', object: 1, paths: [{ activity: 'shopping', price: 10 }] }
    ] });
assert.equal(stock.activity.amount, 10);
assert.equal(stock.activity.price, 100, 'funded leaf spends the complete required quantity');
console.log('wish funding, complete progress hour and acquisition quantity: PASS');

// A craft keeps its full recipe for cost and public demand, but cannot farm
// ordinary resources ahead of its missing key part or learning scroll.
const staged = missingKey => ({ actorKey: 'staged-craft', inputKey: `key:${missingKey}`,
    remembered: false, wallet: 10000, hourAdena: 100, roots: ['gear'], nodes: [
        { key: 'gear', need: 'power', valueHours: 10, paths: [{ kind: 'craft', activity: 'crafting',
            costHours: 1, keyInputs: ['part'], requirements: [
                ...(missingKey ? [{ key: 'part', amount: 12 }] : []), { key: 'ore', amount: 50 }
            ] }] },
        { key: 'part', object: 10, paths: [{ kind: 'drop', activity: 'hunting', costHours: 10 }] },
        { key: 'ore', object: 11, paths: [{ kind: 'drop', activity: 'hunting', costHours: 0.01 }] }
    ] });
assert.equal(network.build(staged(true)).activity.object, 10, 'key part precedes a much cheaper raw resource');
assert.equal(network.build(staged(false)).activity.object, 11, 'raw resources resume after the part is acquired');
const TradeIntent = require('../src/GameServer/Bot/Economy/TradeIntent');
const tradePlan = partMissing => ({ quantityPrepared: true, queue: [{ key: 'power:300:14', valueHours: 10, ratio: 1,
    object: { itemId: 300 }, plan: { kind: 'craft', missingAmount: 1, keyInputs: ['item:10'], requirements: [
        ...(partMissing ? [{ key: 'item:10', amount: 12, plan: { kind: 'drop', missingAmount: 12 } }] : []),
        { key: 'item:11', amount: 50, plan: { kind: 'drop', missingAmount: 50 } }
    ] } }] });
assert.deepEqual(TradeIntent.project({}, tradePlan(true), null, () => 1, 8).map(row => row.itemId), [10],
    'standing bids cannot start buying raw resources before the key parts');
assert.deepEqual(TradeIntent.project({}, tradePlan(false), null, () => 1, 8).map(row => row.itemId), [11],
    'resource orders appear once the parts are complete');

const overpriced = moneyQueue([{ key: 'luxury', valueHours: .5, price: 1000 }], 50000, 0, .001);
assert.equal(overpriced.queue[0].funded, false);
assert.equal(overpriced.gap, null);
assert.equal(overpriced.moneyPrice, .001);
const wealthy = network.build({ ...input, inputKey: 'wealthy-hour', wallet: 1e8, hourAdena: 1000 });
assert.equal(wealthy.hourAdena, 1000);
assert.equal(wealthy.moneyPrice, .001);

const eventInput = { actorKey: 'character:77', characterId: 77, inputKey: 'event:1', decisionSeq: 1,
    activityLeaf: 0, wallet: 10000, hourAdena: 100, persona: { traits: { commitment: 0 } },
    previous: { focus: ['left', 0, 0] }, roots: ['left', 'right'], nodes: [
        { key: 'left', need: 'power', valueHours: 1, paths: [{ activity: 'shopping', costHours: 1 }] },
        { key: 'right', need: 'care', valueHours: 1, paths: [{ activity: 'hunting', costHours: 1 }] }
    ] };
const eventFirst = network.build(eventInput);
assert.equal(eventFirst.decisionSeq, 1);
assert.equal(typeof eventFirst.activityLeaf, 'number');
assert(eventFirst.activityLeaf > 0);
const afterLoot = network.build({ ...eventInput, inputKey: 'bag:2', wallet: eventInput.wallet + 1000,
    activityLeaf: eventFirst.activityLeaf });
assert.equal(afterLoot.activity.key, eventFirst.activity.key, 'loot holds the chosen leaf for this event');
const rolled = new Set();
for (let decisionSeq = 1; decisionSeq <= 50; decisionSeq++) {
    const a = network.build({ ...eventInput, inputKey: `event:${decisionSeq}`, decisionSeq, remembered: false });
    const b = network.build({ ...eventInput, inputKey: `loot:${decisionSeq}`, decisionSeq, wallet: 11000, remembered: false });
    assert.equal(a.activity.key, b.activity.key, 'whole-state keys cannot seed an individual roll');
    rolled.add(a.activity.activity);
}
assert.deepEqual([...rolled].sort(), ['hunting', 'shopping']);
const removed = network.build({ ...eventInput, inputKey: 'leaf-removed', activityLeaf: eventFirst.activityLeaf,
    roots: ['replacement'], nodes: [{ key: 'replacement', need: 'power', valueHours: 1,
        paths: [{ activity: 'crafting', costHours: 1 }] }] });
assert.equal(removed.activity.activity, 'crafting');
assert.notEqual(removed.activityLeaf, eventFirst.activityLeaf);
assert.equal(removed.decisionSeq, 2, 'a new focus raises the decision once before its activity roll');
const sameKeyNewEvent = network.build({ ...eventInput, decisionSeq: 51 });
assert.equal(sameKeyNewEvent.decisionSeq, 51, 'an unchanged input key cannot reuse another decision');
// An event keeps the held step while no other step beats it by the bot's
// loyalty; a step that became much better is rolled for once.
const valued = hours => ({ ...eventInput, previous: { focus: ['right', 0, 0] },
    nodes: [eventInput.nodes[0], { ...eventInput.nodes[1], valueHours: hours }] });
let leftLeaf = 0;
for (let decisionSeq = 1; !leftLeaf && decisionSeq <= 50; decisionSeq++) {
    const pick = network.build({ ...valued(3), decisionSeq, remembered: false });
    if (pick.activity.rootKey === 'left') leftLeaf = pick.activityLeaf;
}
assert(leftLeaf > 0);
const outscoredPicks = new Set();
for (let decisionSeq = 2; decisionSeq <= 30; decisionSeq++) {
    // Loyalty .5: the held off-focus step is worth 1 * .5, the focus step .7 <= .5 * 1.5.
    const loyal = network.build({ ...valued(0.7), persona: { traits: { commitment: 0.5 } }, decisionSeq,
        activityLeaf: leftLeaf, remembered: false });
    assert.equal(loyal.activityLeaf, leftLeaf, 'a step within the loyalty margin survives the event');
    assert.equal(loyal.decisionSeq, decisionSeq);
    const outscored = network.build({ ...valued(3), decisionSeq, activityLeaf: leftLeaf, remembered: false });
    assert.equal(outscored.decisionSeq, decisionSeq + 1, 'an outscored step is rolled for under a new seed');
    outscoredPicks.add(outscored.activity.rootKey);
}
assert(outscoredPicks.has('right'), 'the better step can win the roll');
// Without an event (reconsider false) the held step stays while it is still
// a candidate, however much better another became: no new seed, no roll.
for (let decisionSeq = 2; decisionSeq <= 30; decisionSeq++) {
    const kept = network.build({ ...valued(3), decisionSeq, activityLeaf: leftLeaf, remembered: false, reconsider: false });
    assert.equal(kept.activityLeaf, leftLeaf, 'an ordinary rebuild keeps the held step');
    assert.equal(kept.decisionSeq, decisionSeq, 'an ordinary rebuild does not reseed the roll');
}
const goneWithoutEvent = network.build({ ...eventInput, inputKey: 'leaf-gone-quiet', activityLeaf: eventFirst.activityLeaf,
    previous: { focus: ['replacement', 0, 0] }, roots: ['replacement'], nodes: [{ key: 'replacement', need: 'power', valueHours: 1,
        paths: [{ activity: 'crafting', costHours: 1 }] }], remembered: false, reconsider: false });
assert.equal(goneWithoutEvent.activity.activity, 'crafting', 'a held step that is no longer a candidate is replaced without an event');
assert.equal(goneWithoutEvent.decisionSeq, eventInput.decisionSeq + 1);
// The focus reads the same event gate: a quiet rebuild keeps the held focus
// however much better a challenger became; an event lets it move.
const challenged = { ...eventInput, previous: { focus: ['left', 0, 0] },
    nodes: [eventInput.nodes[0], { ...eventInput.nodes[1], valueHours: 3 }], remembered: false };
const movedFocus = new Set();
for (let decisionSeq = 1; decisionSeq <= 30; decisionSeq++) {
    const quiet = network.build({ ...challenged, decisionSeq, reconsider: false });
    assert.equal(quiet.focus[0], 'left', 'a quiet rebuild keeps the held focus');
    assert.equal(quiet.decisionSeq, decisionSeq, 'a kept focus does not reseed the roll');
    movedFocus.add(network.build({ ...challenged, decisionSeq, reconsider: true }).focus[0]);
}
assert(movedFocus.has('right'), 'an event lets an outscoring focus win the roll');
console.log('PASS individual event seeds / held leaves / missing leaf / focus transition / outscored held leaf / quiet rebuild keeps the leaf and focus');

const liquidationInput = { actorKey: 'finite-sale', inputKey: 'bag', remembered: false,
    wallet: 10, hourAdena: 0, roots: ['upgrade'], nodes: [{ key: 'upgrade', need: 'power',
        valueHours: 1000, price: 254442, paths: [{ activity: 'shopping', price: 254442 }] }],
    moneyPaths: [{ activity: 'selling', kind: 'liquidate', repeatable: false,
        capacityCash: 4171, cashFees: 0, actionHours: .25, items: [1867] }] };
const finiteSale = network.build(liquidationInput);
assert.equal(finiteSale.activity.contribution, 4171);
assert.equal(finiteSale.activity.effort, .25, 'finite cash uses the actual action time');
assert.equal(finiteSale.activity.valueHours, finiteSale.moneyPrice * 4171);
assert(finiteSale.activity.valueHours < 1000, 'one sale cannot claim the entire expensive upgrade');
assert.equal(finiteSale.hourAdena, 0, 'a liquidation never establishes repeatable income');
for (const patch of [{ capacityCash: 0 }, { cashFees: 4171 }, { actionHours: NaN },
    { actionHours: -1 }, { cashFees: NaN }, { capacityCash: Infinity }, { available: false }]) {
    const result = network.build({ ...liquidationInput, inputKey: JSON.stringify(patch),
        moneyPaths: [{ ...liquidationInput.moneyPaths[0], ...patch }] });
    assert.equal(result.activity, null, 'empty, uneconomic or unknown finite actions cannot fund a gap');
}
const cappedSale = network.build({ ...liquidationInput, inputKey: 'large-bag',
    moneyPaths: [{ ...liquidationInput.moneyPaths[0], capacityCash: 300000, cashFees: 100 }] });
assert.equal(cappedSale.activity.contribution, 254432, 'finite value is capped at the remaining gap');
assert.equal(network.build({ ...liquidationInput, inputKey: 'receipt', wallet: 4181,
    activityLeaf: finiteSale.activityLeaf, moneyPaths: [] }).activity, null,
'after receipt an empty bag cannot renew the sale');
console.log('PASS finite liquidation / partial gap / fees / unknown route / receipt');

// FX-E3 keeps PACKET_ROWS itemId rows; a larger funded tail merges into the
// last row with itemId 0. The selected purchase must be payable by that packet.
const { packetFor, PACKET_ROWS } = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const rowItems = result => {
    const packet = packetFor(result, result.hourAdena, 0), items = [];
    for (let index = 4; index + 2 < packet.length; index += 3) if (packet[index + 2]) items.push(packet[index + 2]);
    return items;
};
const manyWishes = count => ({ wallet: 1e6, hourAdena: 1000, remembered: false,
    persona: { traits: { commitment: 0 } }, roots: Array.from({ length: count }, (_, i) => `w${i}`),
    // Queue order follows value per adena; the tail wishes are by far the
    // quickest leaves, so without the row bound they would win most rolls.
    nodes: Array.from({ length: count }, (_, i) => ({ key: `w${i}`, need: 'power', object: { itemId: 100 + i },
        valueHours: 100 - i, price: 100, paths: [{ activity: 'shopping', price: 100, costHours: i >= PACKET_ROWS - 1 ? 0.001 : 10 }] })) });
for (const count of [PACKET_ROWS + 1, PACKET_ROWS + 3]) {
    let selected = 0;
    for (let seed = 0; seed < 40; seed++) {
        const result = network.build({ ...manyWishes(count), actorKey: `rows:${count}:${seed}`, inputKey: `rows:${seed}` });
        assert.equal(result.queue.filter(wish => wish.funded).length, count, 'every wish is funded and its money protected');
        assert.equal(rowItems(result).length, PACKET_ROWS - 1, 'the merged tail row has no itemId');
        assert(result.activity, 'earlier funded rows remain selectable');
        const item = result.activity.object.itemId;
        assert(rowItems(result).includes(item), `selected purchase ${item} has its own money packet row`);
        assert(item < 100 + PACKET_ROWS - 1, 'a merged funded wish waits until earlier rows are paid');
        selected++;
    }
    assert.equal(selected, 40);
}
const exactRows = new Set();
for (let seed = 0; seed < 40; seed++) {
    const result = network.build({ ...manyWishes(PACKET_ROWS), actorKey: `rows:exact:${seed}`, inputKey: `exact:${seed}` });
    assert.equal(rowItems(result).length, PACKET_ROWS);
    assert(rowItems(result).includes(result.activity.object.itemId));
    exactRows.add(result.activity.object.itemId);
}
assert(exactRows.has(100 + PACKET_ROWS - 1), 'with exactly PACKET_ROWS funded wishes the last one owns a row and stays selectable');
console.log('PASS selected purchase is payable by the money packet rows (FX-E3 row bound)');
