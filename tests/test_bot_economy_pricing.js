const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const TradeService = invoke('GameServer/Bot/TradeService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

DataCache.init();
const originalProfile = ProgressionRates.profile;
const originalItems = DataCache.items;

try {
    ProgressionRates.profile = () => ({ adena: 10, drop: 10, spoil: 10, multiplier: 10 });
    // The Adena rate multiplies every player-like price as it multiplies hunt adena.
    assert.strictEqual(BotEconomyPricing.scalePrice(123), 1230, 'bot prices follow the Adena rate');
    // A craft fee and its 1,000,000 cap follow the rate too: two Dragon Slayers (0.03 x 54,000,000) at x10.
    assert.strictEqual(invoke('GameServer/Bot/Economy/CraftShopService').productPrice({ productId: 81, productCount: 2, mpCost: 0 }),
        10000000, 'the craft fee cap is 1,000,000 x the Adena rate');
    // A store line priced by a rate alone sells at the datapack price x the line rate x the Adena rate.
    assert.strictEqual(TradeService.ratedPrice(1, 0.7), Math.round(DataCache.items.find((item) => item.selfId === 1).template.price * 0.7) * 10, 'static merchant prices use the same Adena rate');
    const sellPrice = ItemDisposition.priceFor({ characterId: 1, stats: {} }, { selfId: 1 }, DataCache.items.find((item) => item.selfId === 1));
    assert(sellPrice >= 10, 'cold private-store prices value the item at its datapack price');

    assert(ItemDisposition.basePrice({ selfId: 1 }) > 0, 'the datapack item index must resolve existing templates');
    DataCache.items = [{ selfId: 1, template: { price: 777 } }];
    assert.strictEqual(ItemDisposition.basePrice({ selfId: 1 }), 777,
        'the item index must rebuild when a test or datapack reload replaces the source array');
    console.log('Bot economy pricing checks passed');
} finally {
    ProgressionRates.profile = originalProfile;
    DataCache.items = originalItems;
}
