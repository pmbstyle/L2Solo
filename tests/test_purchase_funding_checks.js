'use strict';
const assert = require('node:assert/strict');
require('../src/GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
require('../src/Global');
invoke('GameServer/DataCache').init();
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const packet = [77000, 1.3e-5, 15000, 0, 4e-5, 20000, 1463];
const dwarf = { characterId: 71, level: 30, adena: 900000, stats: { classId: 1, money: packet } };
assert.equal(Funding.spendable(dwarf, 0, { r: 1.73e-6 }), 0, 'low-margin crystals cannot take wish money');
assert.equal(Funding.spendable(dwarf, 0, { r: 4e-6 }), 0, 'a low-value party fee is refused');
assert.equal(Funding.spendable(dwarf, 0, { itemId: 1463 }), 885000);
assert.equal(Funding.spendable(dwarf, 0, { itemId: 123 }), 0);
assert.equal(Funding.spendable(dwarf, 0, { free: true }), 865000);
assert.equal(Funding.spendable(dwarf, 0, { upperBound: true }), 885000);
assert(Math.abs(Funding.spendable(dwarf, 0, { valueHours: .519 }) - 39923.076923) < .001);
const saving = { ...dwarf, stats: { ...dwarf.stats, money: [77000, 2e-5, 15000, 1200000, 4e-5, 20000, 1463] } };
assert.equal(Funding.spendable(saving, 0, { free: true }), 0);
assert.equal(Funding.spendable(saving, 0, { itemId: 123 }), 0);
assert.equal(Funding.spendable(saving, 0, { r: 2e-5 }), 865000, 'the live gap ratio receives only money above earlier wishes');
assert.equal(Funding.spendable({ ...saving, adena: 10000 }, 0, { survivalCost: 15552 }), 10000);
assert.equal(Funding.spendable({ ...saving, adena: 10000 }, 0, { r: 4e-5 }), 0);
const before = Funding.summary().moneyPacketMissing;
assert.equal(Funding.spendable({ adena: 10000, stats: { money: [77000, 1e-5, 1000] } }, 500), 9500);
assert.equal(Funding.summary().moneyPacketMissing, before + 1);
const queue = Array.from({ length: 9 }, (_, i) => ({ key: String(i), funded: true, price: 100,
    ratio: (9-i) * 1e-4, object: { itemId: 100+i } }));
const merged = Funding.packetFor({ queue, moneyPrice: 1e-5 }, 100000, 1000);
assert.equal(merged.length, 28);
assert.deepEqual(merged.slice(25), [1e-4, 900, 0]);
assert.equal(Funding.spendable({ adena: 10000, stats: { money: merged } }, 0, { itemId: 108 }), 0);
for (let i = 4; i < merged.length; i += 3) {
    assert(merged[i] >= merged[1]);
    assert(Funding.spendable({ adena: 10000, stats: { money: merged } }, 0, { r: merged[i] }) >= 100);
}
assert(Buffer.byteLength(JSON.stringify(merged)) <= 240);
// ARCH-NOTE: the previous fixture pinned removed percentage reserves and a removed
// priority ladder. The packet now proves planner/shop agreement on the real shared gate.
const Population = invoke('GameServer/Bot/Population/PopulationService');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const plan = { status: 'active', strategy: 'market', target: { selfId: 123, slot: 7 }, market: { price: 30000, sourceType: 'npc', town: 'Giran' } };
const state = { ...saving, phase: 'cold', activity: 'hunting', currentRegion: 'Giran', inventory: {},
    stats: { ...saving.stats, equipmentPlan: plan }, timing: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } };
assert.equal(Population.canResumeAffordableMarketPlan(state), false);
assert.notEqual(lifecycleKind(state), 'command');
const funded = { ...state, stats: { ...state.stats, money: [77000, 1e-5, 15000, 0, 4e-5, 30000, 123] } };
assert.equal(Population.canResumeAffordableMarketPlan(funded), true);
assert.equal(lifecycleKind(funded), 'command');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Opportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const originals = [Opportunity.bestOffer, Life.upsertState, Afk.canTradeRemotely];
let seenBudget;
Opportunity.bestOffer = (_id, options) => { seenBudget = options.budget; return null; };
Life.upsertState = async state => state;
Afk.canTradeRemotely = () => false;
(async () => {
    try {
        await Market.tryPurchase({ ...state, activity: 'shopping' }, { type: 'upgrade_gear',
            target: { itemId: 123 }, plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Giran' } });
        assert.equal(seenBudget, 0, 'the shop refuses the same unfunded item');
        console.log('Money queue budgets, survival, merge, escrow and planner/shop agreement: PASS');
    } finally { [Opportunity.bestOffer, Life.upsertState, Afk.canTradeRemotely] = originals; Economy.reset(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
