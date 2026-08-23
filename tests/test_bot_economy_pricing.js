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
    assert.strictEqual(BotEconomyPricing.scalePrice(123), 1230, 'bot prices must scale with the active Adena rate');
    assert.strictEqual(TradeService.ratedPrice(1, 0.7), BotEconomyPricing.scalePrice(DataCache.items.find((item) => item.selfId === 1).template.price * 0.7), 'static merchant prices must use the same rate');
    const sellPrice = ItemDisposition.priceFor({ characterId: 1, stats: {} }, { selfId: 1 }, DataCache.items.find((item) => item.selfId === 1));
    assert(sellPrice >= 10, 'cold private-store prices must use the active rate');

    assert(ItemDisposition.basePrice({ selfId: 1 }) > 0, 'the datapack item index must resolve existing templates');
    DataCache.items = [{ selfId: 1, template: { price: 777 } }];
    assert.strictEqual(ItemDisposition.basePrice({ selfId: 1 }), 777,
        'the item index must rebuild when a test or datapack reload replaces the source array');
    console.log('Bot economy pricing checks passed');
} finally {
    ProgressionRates.profile = originalProfile;
    DataCache.items = originalItems;
}
