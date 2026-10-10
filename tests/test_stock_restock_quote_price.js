'use strict';
// E187: a shot stock wish is ranked at the planner's estimated unit price.
// When the NPC of the town asks more, the optional part of the restock is
// worth less per Adena; below the money price only the survival part is paid.
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
invoke('GameServer/DataCache').init();
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Shot = invoke('GameServer/Inventory/ShotStock');

// Money price 1e-5 hours per Adena, reserve 10,000; the shot wish (1835)
// ranks 1.5e-5 at the estimate and holds 20,000 Adena.
const packet = [50000, 1e-5, 10000, 0, 1.5e-5, 20000, 1835];
const state = { characterId: 9, level: 20, adena: 100000, stats: { classId: 0, money: packet } };
assert.equal(Funding.quoteScale(50, 100), .5);
assert.equal(Funding.quoteScale(0, 100), 1, 'no estimate keeps the rank');
assert.equal(Funding.quoteScale(50, 0), 1, 'no quote keeps the rank');
assert.equal(Funding.stockAllowance(state, null, 1835, 3000, 1), 93000, 'at the estimate: survival + all above the reserve');
assert.equal(Funding.stockAllowance(state, null, 1835, 3000, .8), 93000, 'rank 1.2e-5 still above the money price');
assert.equal(Funding.stockAllowance(state, null, 1835, 3000, .5), 3000, 'rank 7.5e-6: only the survival part');
assert.equal(Funding.stockAllowance(state, { ratio: 1.5e-5 }, 1835, 3000, .5), 3000, 'the wish row gives the same rank');

// The same rule through the shot restock plan: estimate 50, NPC 50 or 100.
const plan = Shot.planForKind('soulshot', 'none');
const context = price => ({
    stock: () => ({ target: 3000, survivalTarget: 1000, unitPrice: 50 }),
    survivalReserve: 10000,
    network: { queue: [{ ratio: 1.5e-5, object: { itemId: plan.selfId } }] },
    statsPacket: { money: packet },
    kitCost: (_id, unitPrice) => 100 * unitPrice,
    price
});
const restock = unitPrice => Shot.restockPlan({ ...state, inventory: { [plan.selfId]: { amount: 400 } } },
    { plan, unitPrice, potionUnitPrice: 0, context: context(unitPrice) });
const atEstimate = restock(50), dear = restock(100);
assert.equal(atEstimate.spendBudget, 95000, 'at the estimate: the kit and all money above the reserve');
assert.equal(atEstimate.amount, 1900);
assert.equal(dear.spendBudget, 10000, 'at twice the estimate only the survival kit is funded');
assert.equal(dear.amount, 100);
assert.equal(100000 - dear.cost, 90000, 'a dry bot keeps its money for the trip and other wishes');

// Players' lines cheaper than the NPC are ranked at their own price: at the
// estimate they are worth buying although the NPC asks twice as much.
const board = Shot.restockPlan({ ...state, inventory: { [plan.selfId]: { amount: 400 } } },
    { plan, unitPrice: 100, potionUnitPrice: 0, context: context(100), offers: [{ price: 50, count: 1000, ownerId: 77 }] });
assert.equal(board.shops.reduce((sum, line) => sum + line.amount, 0), 1000, 'the whole cheap line is bought');
assert.equal(board.npcAmount, 0, 'the NPC remainder stays within the allowance at the NPC price');
assert.equal(board.npcBudget, 10000);
assert.equal(Shot.npcRestockAmount(board, 0, 0), 100, 'a failed line leaves the NPC only its own allowance');
console.log('Stock restock ranked at the quoted NPC price: PASS');
