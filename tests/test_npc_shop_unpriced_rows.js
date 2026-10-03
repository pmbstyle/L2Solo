const assert = require('assert');

const previousRate = process.env.L2NODE_PROGRESSION_RATE;
process.env.L2NODE_PROGRESSION_RATE = 'x10';

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const NpcShopPriceScale = invoke('GameServer/World/Generics/NpcShopPriceScale');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');

// The starter armor dealers list a few items without their own price. The
// buy window sells such a row at the rate-scaled template price; bots must
// read the same price from the same row.
const TALKING_ISLAND_ARMOR = 7002;
const BOOTS = 39;
const LEATHER_HELMET = 44;
const basePrice = (selfId) => DataCache.items.find((item) => item.selfId === selfId).template.price;
const scaled = (selfId) => NpcShopPriceScale.price(basePrice(selfId), 10);

function windowPrices(npcSelfId) {
    const session = {
        activeNpcTalk: { selfId: npcSelfId },
        actor: { backpack: { fetchTotalAdena: () => 0 } },
        dataSendToMe() {}
    };
    BuyShop(session, ['buy', 'npc']);
    return session.activeNpcShop.prices;
}

try {
    const shown = windowPrices(TALKING_ISLAND_ARMOR);
    assert.strictEqual(shown.get(BOOTS), scaled(BOOTS), 'the buy window sells Boots at the scaled template price');
    assert.strictEqual(NpcShopBuyLists.rowForNpc(TALKING_ISLAND_ARMOR, BOOTS)?.price, shown.get(BOOTS),
        'the shop row must carry the price the window shows');
    for (const row of NpcShopBuyLists.fetchForNpc(TALKING_ISLAND_ARMOR)) {
        assert.strictEqual(row.price, shown.get(row.selfId), `item ${row.selfId}: row and window prices differ`);
    }

    const offer = MarketOpportunity.npcOffers(BOOTS, 'Talking Island')[0];
    assert(offer?.available, 'a bot in Talking Island must see the Boots the dealer sells');
    assert.strictEqual(offer.price, scaled(BOOTS));
    assert.strictEqual(BotMarketPricing.npcPrice({ selfId: BOOTS }), scaled(BOOTS),
        'the cheapest town NPC price includes the village dealers');

    // Static buyers pay at most 90% of the cheapest repeatable purchase; an
    // unpriced row is bought at its scaled price, not at the raw base price.
    assert.strictEqual(StaticMerchantPricing.cheapestPurchase(LEATHER_HELMET), scaled(LEATHER_HELMET));
} finally {
    if (previousRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = previousRate;
}

console.log('NPC shop unpriced row checks passed');
