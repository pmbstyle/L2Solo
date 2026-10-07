const assert = require('assert');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const NpcShopPriceScale = require('../src/GameServer/World/Generics/NpcShopPriceScale');
const Rates = invoke('GameServer/ProgressionRates');

// E91: a made item no NPC sells (a D shot) is priced by its cost with the NPC
// buy-back as the floor and no NPC ceiling; where an NPC sells it, that
// ceiling stays, the NPC being the buyer's other source.
const shot = DataCache.items.find(item => Number(item.selfId) === 1463);
const base = Number(shot.template.price);
const floor = NpcSellRules.npcBuyPrice(base);
const ceiling = NpcShopPriceScale.price(base, Rates.profile().multiplier);

FirstPrice.resetCache();
BotMarketPricing.useNpcOfferSnapshot([{ selfId: 1785, price: 550 }]);
const open = FirstPrice.firstPrice(1463, { spots: [] });
assert.strictEqual(open.source, 'craft');
const cost = Math.round(open.materials + open.labour);
assert(cost > ceiling, `the fixture needs a cost above the NPC price (${cost} vs ${ceiling})`);
assert.strictEqual(open.price, Math.max(floor, cost), 'no NPC sells it: priced by its cost');

FirstPrice.resetCache();
BotMarketPricing.useNpcOfferSnapshot([{ selfId: 1785, price: 550 }, { selfId: 1463, price: ceiling }]);
const sold = FirstPrice.firstPrice(1463, { spots: [] });
assert.strictEqual(sold.price, ceiling, 'an NPC sells it: the NPC price caps the made price');

console.log('first price of made items passed');
process.exit(0);
