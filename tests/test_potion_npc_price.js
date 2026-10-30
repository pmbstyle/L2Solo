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
    // A bot's own round prices the shots and potions it used as the table's
    // rows do (netIncome over consumablePrices): one price per consumable.
    const shot = invoke('GameServer/Inventory/ShotStock').planForState({ level: 62, stats: { classId: 2 }, inventory: {} }).selfId;
    const bag = (potions, shots) => ({ [potion.selfId]: { selfId: potion.selfId, amount: potions }, [shot]: { selfId: shot, amount: shots } });
    const bot = { characterId: 1, level: 62, stats: { classId: 2 }, inventory: bag(50, 500), timing: {} };
    const at = 1800000000000;
    const own = Hunt.recordRound(bot, { patch: { inventory: bag(40, 400) }, events: [], nextResolveAt: at + 60000,
        materialize: { exp: 0, sp: 0, adena: 0, items: [] }, debug: { fights: 2, wins: 2, combatMs: 20000, spotId: 'field' } },
    { exp: 100, timestamp: at, startedAt: at - 60000 }).huntEfficiency[0];
    const table = -Hunt.netIncome({ shots: 100, potions: 10 }, Hunt.consumablePrices(bot));
    assert(table > 10 * 330, `the table pays the rate's prices (${table})`);
    assert.equal(own.costs, table, 'the own sample costs what the table row costs');
    useRate('x1');
    assert.equal(Potions.purchasePotionFor({ level: 62 }).price, Pricing.botPurchasePrice(potion.selfId));
} finally { useRate(original); }
console.log('PASS potion NPC price');
