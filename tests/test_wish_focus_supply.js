'use strict';
// A stock wish nobody can supply never takes the bot off what it can do (T178).
const assert = require('node:assert/strict');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
function build(availableUnits, gear = true, commitment = 0) {
    const nodes = [
        { key: 'power:95:14', need: 'power', progressionPriority: 3, valueHours: 10, object: { itemId: 95, slot: 14 },
            paths: [{ requirements: [{ key: 'item:95', amount: 1 }] }] },
        { key: 'item:95', paths: [{ kind: 'buy', activity: 'shopping', itemId: 95, price: 1000, quoted: true,
            executable: true, availableUnits: 1 }] },
        { key: 'stock:shots', need: 'power', progressionPriority: 4, valueHours: 100,
            object: { itemId: 1464, amount: 10, kind: 'shots' }, paths: [{ requirements: [{ key: 'item:1464', amount: 10 }] }] },
        { key: 'item:1464', paths: [{ kind: 'buy', activity: 'shopping', itemId: 1464, price: 100, quoted: true,
            executable: true, availableUnits }] }];
    return new WishNetwork().build({ actorKey: 'supply', inputKey: `${availableUnits}:${gear}`, nodes,
        roots: [...(gear ? ['power:95:14'] : []), 'stock:shots'], stockFor: () => ({ owned: 0 }),
        wallet: 1000000, hourAdena: 100000, persona: { traits: { commitment } }, remembered: false });
}
let result = build(100);
assert.equal(result.focus[0], 'stock:shots', 'stock a seller can close keeps its survival priority');
result = build(0);
assert.equal(result.focus[0], 'power:95:14', 'stock nobody sells does not hold the focus');
assert.equal(result.activity.itemId, 95, 'the bot goes for the gear it can buy');
assert(result.queue.some(wish => wish.key === 'stock:shots'), 'the wish keeps its queue place and its bid');
assert.equal(build(0, false).focus[0], 'stock:shots', 'with nothing else to do it still stands');
assert.equal(build(0, true, 0.5).queue.find(wish => wish.key === 'stock:shots').valueHours, 100,
    'losing the focus does not cut the bid');
console.log('PASS unsupplied stock / survival stock / queue place');
