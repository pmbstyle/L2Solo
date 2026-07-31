const assert = require('assert');

require('../src/Global');

const Policy = invoke('GameServer/Bot/Economy/PersonaEconomicPolicy');

const wealthState = {
    characterId: 1,
    persona: { primaryDrive: 'wealth', traits: {} }
};
const sale = {
    itemCount: 2,
    marketValue: 550,
    items: [{ selfId: 1864, name: 'Stem', count: 2, price: 275 }]
};
const opportunity = Policy.wealthSaleOpportunity(wealthState, sale);
assert(opportunity, 'a wealth bot should notice a small but concrete sell opportunity');
assert.strictEqual(opportunity.priorityBonus, Policy.WEALTH_SALE_PRIORITY_BONUS);
assert.deepStrictEqual(opportunity.focus, { itemId: 1864, itemName: 'Stem', count: 2, unitPrice: 275, value: 550 });

assert.strictEqual(
    Policy.wealthSaleOpportunity({ characterId: 2, persona: { primaryDrive: 'progression', traits: {} } }, sale),
    null,
    'non-wealth bots must keep the normal sale threshold'
);

console.log('Bot persona economic policy checks passed');
