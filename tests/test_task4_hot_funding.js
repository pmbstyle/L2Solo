'use strict';
// Task 4 B3: a hot bot budgets and pays a card leaf by the same funding terms
// a cold goal uses (its funded root's place in the money queue), and a hot
// shot restock line carries its stock terms to the native writer.
require('../src/Global');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');

// One ratio rule for a card leaf: the card's own r, else its funded root's.
const funded = { key: 'item:49', funded: true, ratio: 0.123456 };
assert.equal(Funding.leafRatio({ r: 0.05 }, funded), 0.05);
assert.equal(Funding.leafRatio({}, funded), Funding.significant(0.123456));
assert.equal(Funding.leafRatio({}, { ...funded, funded: false }), 0);
assert.equal(Funding.leafRatio(null, null), 0);
assert.deepEqual(Funding.stockTerms(null, 1835, 40), { itemId: 1835, survivalCost: 40 });
assert.deepEqual(Funding.stockTerms({ ratio: 0.0421 }, 1835, 40), { itemId: 1835, survivalCost: 40, r: 0.0421 });

// Hot shopping of a material leaf whose root is another item: the money packet
// has no row for the material (r 0 by item), so the root's ratio funds it.
const STEM = 1864, ROOT = 49;
const money = [100000, 0.01, 0, 0, 0.2, 5000, ROOT];
const leaf = { activity: 'shopping', itemId: STEM, amount: 2, rootKey: 'item:49', town: 'Giran', sourceType: 'afk' };
let budget = null;
const offer = { sourceType: 'afk_bot_store', sourceId: 7, lineId: 11, selfId: STEM, price: 100, count: 5, town: 'Giran',
    locX: 1, locY: 2, locZ: 3 };
const deps = {
    'GameServer/World/World': {},
    'GameServer/Bot/Population/BotLifeState': { inventorySummaryFromItems: () => ({}) },
    'GameServer/Bot/AI/GearAcquisitionPlanner': {},
    'GameServer/Bot/Economy/PurchaseFunding': Funding,
    'GameServer/Bot/Economy/MarketOpportunity': { bestOffer: (_id, options) => { budget = options.budget; return offer; },
        offerTarget: () => ({ town: 'Giran' }) },
    'GameServer/Bot/Economy/TownNpcCatalog': {},
    'GameServer/Bot/AI/BotMammonUnseal': { plan: () => null },
    'GameServer/Bot/AI/CompanionDualSwordCrafting': { plan: () => ({ handled: false }) },
    'GameServer/Bot/Economy/EconomyContext': { routeState: state => state, forState: () => ({
        network: { activity: leaf, queue: [{ key: 'item:49', funded: true, ratio: 0.2, object: { itemId: ROOT } }] },
        statsPacket: { money }, worth: () => Infinity }) },
    'GameServer/DataCache': { items: [] }
};
const sandbox = { module: { exports: {} }, invoke: name => deps[name] || invoke(name), console,
    require: name => name.endsWith('PartyMembershipPublication') ? () => {} : name.endsWith('ItemTemplateIndex')
        ? { find: () => ({ template: { name: 'Stem' }, etc: { slot: 0 } }) } : require(name) };
const file = path.resolve(__dirname, '../src/GameServer/Bot/AI/CompanionEquipmentShopping.js');
vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
const Shopping = sandbox.module.exports;
const session = { coldLifeState: { characterId: 5, stats: {} } };
const bot = { fetchId: () => 5, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
    backpack: { fetchItemFromSelfId: id => id === 57 ? { fetchAmount: () => 100000 } : null, fetchItems: () => [] } };
const errand = Shopping.planErrand(session, bot, { name: 'Giran' });
assert.equal(errand.kind, 'market_purchase');
assert.deepEqual({ ...errand.funding }, { itemId: STEM, r: 0.2 }, 'the native writer gets the root ratio');
assert(budget > 0, 'the leaf is budgeted by its root, not by an absent item row');
assert.equal(session.coldLifeState.stats.equipmentPlan.valueRate, 0.2);
const byItem = Funding.spendable({ adena: 100000, stats: { money } }, 0, { itemId: STEM });
assert.equal(byItem, 0, 'the old item-row terms fund nothing for this leaf');

// A shot restock line: the stock terms the planner budgeted it with.
const Shots = invoke('GameServer/Inventory/ShotStock');
const plan = { selfId: 1835, kind: 'soulshot' };
const context = { stock: () => ({ target: 500, survivalTarget: 500, unitPrice: 7 }), survivalReserve: 0,
    kitCost: (_id, price) => 40 * price, network: { queue: [{ object: { itemId: 1835 }, ratio: 0.0421 }] },
    statsPacket: { money: [100000, 0.001, 0, 0, 0.0421, 100000, 1835] } };
const restock = Shots.restockPlan({ characterId: 6, phase: 'hot', adena: 100000, inventory: { 57: { amount: 100000 } },
    stats: {} }, { plan, context, unitPrice: 7, adena: 100000,
    offers: [{ price: 5, count: 100, lineId: 3 }, { price: 6, count: 100, lineId: 4 }] });
assert.equal(restock.shops.length, 2);
assert.deepEqual(restock.shops.map(line => line.funding),
    [{ itemId: 1835, survivalCost: 200, r: 0.0421 }, { itemId: 1835, survivalCost: 240, r: 0.0421 }]);
console.log('test_task4_hot_funding: ok');
