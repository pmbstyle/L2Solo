'use strict';
// Market MVP-1/2/3 contract fixtures: money only behind a path with a step
// now, exact child outcome propagation and the one quantity reader.
const assert = require('node:assert/strict');
const { WishNetwork, moneyQueue, remainingQuantity } = require('../src/GameServer/Bot/Economy/WishNetwork');
const PurchaseFunding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const { fnv1a32 } = require('../src/GameServer/Bot/Fnv1a');
const done = label => console.log('PASS ' + label);

// MVP-3: accepted incoming removes the amount to order, not to deliver.
assert.deepEqual(remainingQuantity({ required: 30, freePhysical: 4, acceptedIncoming: 2 }), { toOrder: 24, toExecute: 26 });
assert.deepEqual(remainingQuantity({ required: 3, freePhysical: 5, acceptedIncoming: 2 }), { toOrder: 0, toExecute: 0 });
assert.deepEqual(remainingQuantity({ required: 3, freePhysical: 1, acceptedIncoming: 9 }), { toOrder: 0, toExecute: 2 });
done('one quantity reader: order and execution remainders');

// The eight native funding controls, for a bot and for a clan actor.
const node = (key, benefit, price, extra = {}) => ({ key, need: 'power', object: { itemId: key === 'future' ? 100 : 200 },
    valueHours: benefit, price, paths: [{ kind: 'board', activity: 'shopping', price, costHours: 0.1, ...extra }] });
const run = (name, nodes, extra = {}) => [false, true].map(clan => new WishNetwork().build({
    actorKey: clan ? 'clan:77' : 'character:77', characterId: clan ? undefined : 77, inputKey: name, decisionSeq: 1,
    wallet: 20, hourAdena: 100, persona: { traits: { commitment: 0 } }, previous: { focus: ['future', 0, 100] },
    roots: nodes.map(row => row.key), nodes, ...extra }));
const wish = (result, key) => result.queue.find(row => row.key === key);
const future = node('future', 100, 100, { executable: false, availableUnits: 0 });
const ready = node('ready', 8, 10, { executable: true, availableUnits: 1 });
for (const result of run('future-unaffordable-no-income', [future, ready])) {
    assert.equal(result.queue.length, 2, 'an unsupported wish keeps its queue place');
    assert.equal(wish(result, 'future').funded, false);
    assert.equal(wish(result, 'future').supported, false);
    assert.equal(wish(result, 'ready').funded, true, 'available useful progress is funded');
    assert.equal(result.gap, null, 'an unsupported wish is never the funding gap');
    assert.equal(result.available, 10, 'an unsupported wish subtracts nothing');
    assert.equal(result.activity?.rootKey, 'ready');
    assert.equal(result.focus[0], 'future', 'focus and interest stay');
}
for (const result of run('explicit-source-unavailable', [node('future', 100, 100, { available: false }), ready])) {
    assert.equal(result.queue.length, 1); assert.equal(result.activity?.rootKey, 'ready');
}
for (const result of run('future-supported-earning', [future, ready], { moneyPaths: [{ activity: 'hunting', incomePerHour: 10 }] })) {
    assert.equal(wish(result, 'ready').funded, true);
    assert.equal(result.gap, null, 'no earning toward an unsupported wish');
    assert.equal(result.activity?.rootKey, 'ready'); assert.equal(!!result.activity.funding, false);
}
for (const result of run('future-affordable-no-supplier', [node('future', 100, 10, { executable: false, availableUnits: 0 }), ready], { wallet: 10 })) {
    assert.equal(wish(result, 'future').funded, false);
    assert.equal(wish(result, 'ready').funded, true);
    assert.equal(result.activity?.rootKey, 'ready');
}
const alternative = { ...future, paths: [...future.paths, { kind: 'craft', activity: 'crafting', costHours: 1, executable: true, availableUnits: 1 }] };
for (const result of run('future-has-executable-alternative', [alternative, ready])) {
    assert(wish(result, 'future').plan.executable && wish(result, 'future').supported);
    assert.equal(result.gap?.key, 'future', 'a supported saving goal still holds the money');
    assert(result.activity);
}
for (const result of run('survival-reserve-preserved', [ready], { wallet: 20, survivalReserve: 20 })) {
    assert.equal(result.activity, null); assert.equal(result.available, 0); assert.equal(result.queue[0].funded, false);
}
for (const result of run('both-funded', [node('future', 100, 10, { executable: true, availableUnits: 1 }), ready], { wallet: 100 })) {
    assert(result.queue.length === 2 && result.queue.every(row => row.funded) && result.activity);
}
const heldInput = { actorKey: 'character:77', characterId: 77, inputKey: 'held', decisionSeq: 2, wallet: 100, hourAdena: 100,
    persona: { traits: { commitment: 0 } }, previous: { focus: ['ready', 0, 0] }, roots: ['old', 'ready'],
    nodes: [{ key: 'old', need: 'care', valueHours: 1, paths: [{ activity: 'helping', costHours: 1 }] },
        { key: 'ready', need: 'power', valueHours: 100, paths: [{ activity: 'hunting', costHours: 1 }] }],
    activityLeaf: fnv1a32('old:old:helping') };
const heldNetwork = new WishNetwork();
assert.equal(heldNetwork.build(heldInput).activity.rootKey, 'old');
assert.equal(heldNetwork.build({ ...heldInput, inputKey: 'gone', nodes: [{ ...heldInput.nodes[0],
    paths: [{ activity: 'helping', available: false }] }, heldInput.nodes[1]] }).activity.rootKey, 'ready');
done('eight funding controls for bot and clan: money only behind a step now');

// Supported but not executable: a craft whose material is on sale keeps the
// saving goal; an unobserved buy beside it is not chosen over it.
const prepared = new WishNetwork().build({ actorKey: 'character:5', characterId: 5, inputKey: 'prep', wallet: 10, hourAdena: 100,
    persona: { traits: { commitment: 0 } }, roots: ['gear'], nodes: [
        { key: 'gear', need: 'power', valueHours: 50, price: 100, paths: [
            { kind: 'buy', activity: 'shopping', price: 100, executable: false, availableUnits: 0 },
            { kind: 'craft', activity: 'crafting', costHours: 0.1, requirements: [{ key: 'ore', amount: 2 }] }] },
        { key: 'ore', price: 30, paths: [{ kind: 'buy', activity: 'shopping', price: 30, executable: true, availableUnits: 1 }] }] });
assert.equal(prepared.queue[0].plan.kind, 'craft');
assert.equal(prepared.queue[0].supported, true);
assert.equal(prepared.queue[0].plan.executable, false, 'one unit for sale, two required');
assert.equal(prepared.gap?.key, 'gear', 'genuine saving stays the gap');
done('non-executable is not unsupported: preparation keeps its money claim');

// MVP-2: a 60% attempt valued directly and wrapped by a goal is equal.
const attempt = (repeatableInputs, wrapped) => {
    const material = repeatableInputs
        ? { key: 'mat', price: 10, paths: [{ kind: 'buy', activity: 'shopping', price: 10, executable: true }] }
        : { key: 'mat', price: 10 };
    const craft = { kind: 'craft', activity: 'crafting', costHours: 0.5, successProbability: 0.6, requirements: [{ key: 'mat', amount: 1 }] };
    const nodes = wrapped
        ? [{ key: 'goal', need: 'power', valueHours: 100, paths: [{ activity: 'equip', requirements: [{ key: 'item', amount: 1 }] }] },
            { key: 'item', price: 50, paths: [craft] }, material]
        : [{ key: 'goal', need: 'power', valueHours: 100, paths: [craft] }, material];
    return new WishNetwork().build({ actorKey: 'character:9', characterId: 9, inputKey: 'attempt', wallet: 1000, hourAdena: 10,
        persona: { traits: { commitment: 0 } }, roots: ['goal'], nodes }).queue[0];
};
for (const repeatableInputs of [false, true]) {
    const direct = attempt(repeatableInputs, false), wrapped = attempt(repeatableInputs, true);
    assert(Math.abs(direct.valueHours - wrapped.valueHours) < 1e-9, `direct ${direct.valueHours} wrapped ${wrapped.valueHours}`);
    assert(Math.abs(direct.plan.price - wrapped.plan.price) < 1e-9 && Math.abs(direct.plan.effort - wrapped.plan.effort) < 1e-9);
    assert.equal(direct.valueHours, repeatableInputs ? 100 : 60);
}
assert(Math.abs(attempt(true, false).plan.price - 10 / 0.6) < 1e-9, 'until success: one attempt cash x 1/p');
assert.equal(attempt(false, false).plan.price, 10, 'one attempt: inputs are not divided by chance');
done('60% attempt: direct and wrapped equal; until success only with repeatable inputs');

// Two independent random branches compose; a ninth branch is unresolved.
const branches = count => new WishNetwork().build({ actorKey: 'character:3', characterId: 3, inputKey: `b${count}`, wallet: 1000,
    hourAdena: 10, persona: { traits: { commitment: 0 } }, roots: ['goal'], nodes: [
        { key: 'goal', need: 'power', valueHours: 100, price: 40, paths: [{ activity: 'equip', price: 40,
            requirements: Array.from({ length: count }, (_, at) => ({ key: `part${at}`, amount: 1 })) }] },
        // A held gem has no repeatable source: each part is one native attempt.
        { key: 'gem', price: 1 },
        ...Array.from({ length: count }, (_, at) => ({ key: `part${at}`, price: 10, paths: [{ kind: 'craft', activity: 'crafting',
            costHours: 0.1, successProbability: 0.5, requirements: [{ key: 'gem', amount: 1 }] }] }))] }).queue[0];
const two = branches(2);
assert.equal(two.plan.branches, 4); assert.equal(two.valueHours, 25); assert.equal(two.resolved, true); assert.equal(two.funded, true);
const three = branches(3);
assert.equal(three.plan.branches, 8); assert.equal(three.resolved, true);
const four = branches(4);
assert.equal(four.plan.branches, 16);
assert.equal(four.resolved, false, 'composition overflow is unresolved');
assert.equal(four.funded, false, 'an unresolved evaluation commits no money');
assert(four.valueHours > 0, 'interest is retained');
done('two independent branches compose; overflow past eight is unresolved, unfunded');

// moneyQueue: an unsupported row neither funds, nor becomes the gap, nor
// truncates the money packet or a later funded row.
const mixed = moneyQueue([{ key: 'dream', valueHours: 100, price: 10, supported: false },
    { key: 'bread', valueHours: 5, price: 4 }, { key: 'boots', valueHours: 3, price: 6 }], 8, 0, 0.01);
assert.deepEqual(mixed.queue.map(row => [row.key, row.funded]), [['dream', false], ['bread', true], ['boots', false]]);
assert.equal(mixed.gap.key, 'boots'); assert.equal(mixed.available, 4);
const packet = PurchaseFunding.packetFor(mixed, 100, 0);
assert.equal(packet.length, 7, 'the funded row after an unsupported one is published');
assert.equal(packet[5], 4);
done('money packet skips unsupported rows');
