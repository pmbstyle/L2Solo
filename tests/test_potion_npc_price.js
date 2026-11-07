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
    // A city store sells a bot only shots (ProductionPolicy): a young bot's
    // Lesser Healing Potion and Scroll of Escape cost what an NPC asks, and a
    // potion only a city store sells has no bot price.
    const lesser = Potions.purchasePotionFor({ level: 10 });
    for (const id of [lesser.selfId, 736]) {
        assert(Pricing.cheapestPurchase(id) < Pricing.botPurchasePrice(id), `fixture: a city store sells ${id} cheaper to a player`);
        assert.equal(Pricing.botPurchasePrice(id), Pricing.botNpcListPrice(id), `a bot pays the NPC for ${id}`);
    }
    assert.equal(lesser.price, Pricing.botPurchasePrice(lesser.selfId));
    assert(Number.isFinite(Pricing.cheapestPurchase(1539)), 'fixture: a city store sells the Greater Healing Potion');
    assert.equal(Pricing.botPurchasePrice(1539), Infinity, 'no bot can buy it');
    // One NPC price table (town sellers, cheapest row): a bot's NPC price, the
    // survival reserve and a scrap craft's input price are what a town NPC
    // asks; an item no town NPC sells (Haste Potion) has none.
    const Shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
    const Index = invoke('GameServer/Bot/Economy/ShotMarketIndex').native();
    Index.refreshNpc();
    for (const id of [lesser.selfId, 736, 1835, 3947, 1062]) {
        const town = Shops.townPriceForItem(id) ?? Infinity;
        assert.equal(Pricing.botNpcListPrice(id), town, `a bot's NPC price of ${id} is the town's`);
        assert.equal(Index.npcPrice.get(id) ?? Infinity, town, `the craft index prices ${id} as the town`);
    }
} finally { useRate(original); }
console.log('PASS potion NPC price');
