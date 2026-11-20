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
    // Prices are x1 at every preset: the Adena rate multiplies hunt adena only.
    assert.strictEqual(BotEconomyPricing.scalePrice(123), 123, 'bot prices stay x1 at every Adena rate');
    // A store line priced by a rate alone sells at the datapack price x the rate, rounded (the configured stores' rule).
    assert.strictEqual(TradeService.ratedPrice(1, 0.7), Math.round(DataCache.items.find((item) => item.selfId === 1).template.price * 0.7), 'static merchant prices use the same x1 price');
    const sellPrice = ItemDisposition.priceFor({ characterId: 1, stats: {} }, { selfId: 1 }, DataCache.items.find((item) => item.selfId === 1));
    assert(sellPrice >= 10, 'cold private-store prices value the item at its x1 datapack price');

    assert(ItemDisposition.basePrice({ selfId: 1 }) > 0, 'the datapack item index must resolve existing templates');
    DataCache.items = [{ selfId: 1, template: { price: 777 } }];
    assert.strictEqual(ItemDisposition.basePrice({ selfId: 1 }), 777,
        'the item index must rebuild when a test or datapack reload replaces the source array');
    console.log('Bot economy pricing checks passed');
} finally {
    ProgressionRates.profile = originalProfile;
    DataCache.items = originalItems;
}
