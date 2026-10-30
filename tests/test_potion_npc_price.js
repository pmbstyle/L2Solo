'use strict';
// A bot prices a healing potion at what the NPC charges at the server rate
// (StaticMerchantPricing), not its template price: at x10 the Healing Potion
// (1061, 330) costs 660, and the hunt model's consumable price says the same.
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const original = process.env.L2NODE_PROGRESSION_RATE;
try {
    useRate('x10');
    const potion = Potions.purchasePotionFor({ level: 62 });
    assert.equal(potion.price, Pricing.botPurchasePrice(potion.selfId), 'the NPC price at the rate');
    assert(potion.price > 330, `x10 raises the NPC price (${potion.price})`);
    assert.equal(Hunt.consumablePrices(HuntCycle.referenceState(2, 62)).potions, potion.price, 'the hunt model pays the same');
    useRate('x1');
    assert.equal(Potions.purchasePotionFor({ level: 62 }).price, Pricing.botPurchasePrice(potion.selfId));
} finally { useRate(original); }
console.log('PASS potion NPC price');
