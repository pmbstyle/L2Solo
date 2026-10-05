const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const PersonaEconomicPolicy = invoke('GameServer/Bot/Economy/PersonaEconomicPolicy');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const BuyStore = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const WealthCraft = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
Data.init();

// Pins the numeric edges of the economy rules; the surrounding behaviour is
// covered by test_bot_gear_acquisition.js, test_bot_market_listing_policy.js
// and test_cold_wealth_craft.js.

// Purchases keep max(500, level x 250, 10% of adena) unspent.
assert.strictEqual(Gear.operationalAdenaReserve({ level: 1, adena: 0 }), 500);
assert.strictEqual(Gear.operationalAdenaReserve({ level: 10, adena: 0 }), 2500);
assert.strictEqual(Gear.operationalAdenaReserve({ level: 10, adena: 100000 }), 10000);
assert.strictEqual(Gear.operationalAdenaReserve({ level: 10, inventory: { 57: { amount: 100001 } } }), 10001,
    'adena carried only in the inventory counts too');

// A sell trip starts at 3 sale items or a market value of 1000.
const originals = { saleSummary: ItemDisposition.saleSummary, wealthSale: PersonaEconomicPolicy.wealthSaleOpportunity };
const sells = (itemCount, marketValue) => {
    ItemDisposition.saleSummary = () => ({ itemCount, marketValue, items: [] });
    PersonaEconomicPolicy.wealthSaleOpportunity = () => null;
    return NeedsEvaluator.evaluate({ characterId: 9101, level: 20, adena: 100000, phase: 'cold', activity: 'hunting',
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, inventory: {}, stats: {} }, { now: 1000 })
        .some((candidate) => candidate.type === 'sell_inventory');
};
try {
    assert.strictEqual(sells(3, 0), true, '3 items are worth a trip');
    assert.strictEqual(sells(2, 999), false, '2 items worth 999 are not');
    assert.strictEqual(sells(1, 1000), true, 'a market value of 1000 is worth a trip');
} finally {
    ItemDisposition.saleSummary = originals.saleSummary;
    PersonaEconomicPolicy.wealthSaleOpportunity = originals.wealthSale;
}

// The reference price is the lower of the rate-scaled base price and the
// NPC price. No listing floor (group E): a WTB bid is the mirror of the
// bot's ask, at or under what the item is worth to it.
const BOW = 274;
const item = { selfId: BOW, basePrice: 1000000 };
const scaledBase = BotEconomyPricing.scalePrice(item.basePrice);
BotMarketPricing.useNpcOfferSnapshot([{ selfId: BOW, price: Math.floor(scaledBase / 2) }]);
assert.strictEqual(BotMarketPricing.referencePrice(item), Math.floor(scaledBase / 2), 'a cheaper NPC price is the reference');
BotMarketPricing.useNpcOfferSnapshot([]);
assert.strictEqual(BotMarketPricing.referencePrice(item), scaledBase, 'without NPC stock the scaled base price is the reference');
assert.strictEqual(BotMarketPricing.listingFloor, undefined, 'no listing floor');
const bid = (adena) => BuyStore.bidFor({ characterId: 9102, adena: 1000000000, inventory: {} },
    { type: 'upgrade_gear', target: { itemId: BOW, adena }, plan: { priceSource: 'offer' } });
const low = bid(1000);
assert(!low || low.price <= 1000, 'a bid stays at or under what the item is worth to the buyer');
assert(bid(scaledBase).price <= scaledBase);

// A wealth crafter does not craft while it holds its own WTB.
const crafter = { characterId: 9103, accountName: 'bot_pop_test', name: 'Crafter', phase: 'cold',
    activity: 'hunting', level: 60, adena: 500000, vitals: { mp: 100 }, inventory: {},
    stats: { classId: 57, generatedIndex: 1787947094937 }, persona: { primaryDrive: 'wealth' } };
assert.strictEqual(WealthCraft.eligible(crafter), true);
const ownerRecords = AfkTrade.ownerRecords;
try {
    AfkTrade.ownerRecords = (id) => Number(id) === 9103
        ? [{ kind: 'buy_ad', storeType: AfkTrade.BUY, escrowAdena: 1000, lines: [] }] : [];
    assert.strictEqual(WealthCraft.eligible(crafter), false, 'its own buy ad comes first');
} finally {
    AfkTrade.ownerRecords = ownerRecords;
}

console.log('test_bot_economy_thresholds passed');
