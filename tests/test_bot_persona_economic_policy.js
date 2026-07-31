const assert = require('assert');

require('../src/Global');

const Policy = invoke('GameServer/Bot/Economy/PersonaEconomicPolicy');

const wealthState = {
    characterId: 1,
    persona: { primaryDrive: 'wealth', traits: {} }
};
const sale = {
    itemCount: 2,
    marketValue: 650,
    items: [
        { selfId: 1864, name: 'Stem', count: 2, price: 275 },
        { selfId: 1865, name: 'Animal Bone', count: 10, price: 10 }
    ]
};
const opportunity = Policy.wealthSaleOpportunity(wealthState, sale);
assert(opportunity, 'a wealth bot should notice a small but concrete sell opportunity');
assert.strictEqual(opportunity.priorityBonus, Policy.WEALTH_SALE_PRIORITY_BONUS);
assert.deepStrictEqual(opportunity.focus, { itemId: 1864, itemName: 'Stem', count: 2, unitPrice: 275, value: 550 });

assert.strictEqual(
    Policy.wealthSaleOpportunity(wealthState, {
        itemCount: 2,
        marketValue: 20,
        items: [{ selfId: 1865, name: 'Animal Bone', count: 2, price: 10 }]
    }),
    null,
    'two trivial items must not trigger a market trip'
);

assert.deepStrictEqual(
    Policy.wealthSaleOpportunity(wealthState, {
        itemCount: 3,
        marketValue: 700,
        items: [
            { selfId: 100, name: 'Rare Fragment', count: 1, price: 300 },
            { selfId: 101, name: 'Material Stack', count: 4, price: 100 }
        ]
    }).focus,
    { itemId: 101, itemName: 'Material Stack', count: 4, unitPrice: 100, value: 400 },
    'the focus must be the highest total-value item, not merely the first candidate'
);

assert.strictEqual(
    Policy.wealthSaleOpportunity({ characterId: 2, persona: { primaryDrive: 'progression', traits: {} } }, sale),
    null,
    'non-wealth bots must keep the normal sale threshold'
);

console.log('Bot persona economic policy checks passed');
