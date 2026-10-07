const assert = require('assert');

require('../src/Global');
process.env.L2NODE_PROGRESSION_RATE = 'x10';
invoke('GameServer/DataCache').init();
const Profit = require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
const RecipeWorth = require('../src/GameServer/Bot/Economy/RecipeWorth');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const Recipes = invoke('GameServer/Items/C4RecipeItems');

// E92: a shot recipe is worth what it adds to the crafter's hour over its
// horizon, read from the board: the units the board takes (deals and funded
// unmet bids) shared with the visible sellers, plus the shots the bot burns
// itself (all of their combat gain while nobody sells them).
Profit.contextFor = () => ({ hourAdena: 60000, mpPerHour: 4000 });
const recipe = Recipes.resolveByRecipeId(20); // Soulshot D, 156 per craft
const state = { characterId: 4242, level: 40, stats: {} };
const economy = (use = 0, understanding = 0.5) => ({
    hunt: { perHour: 60000, expPerHour: 200000 },
    persona: { understanding },
    stock: () => ({ itemId: use ? 1463 : 0, usePerHour: use, benefitHours: 0.9, targetHours: 2 })
});
const at = Date.now();
const route = (demand = 0) => ({ salePrice: 22, cost: 2000, demand });
const offer = count => ({ count, price: 22 });
const worth = (opts, r = route(20000)) => RecipeWorth.of(state, recipe, r, { now: at, ...opts });
assert.strictEqual(RecipeWorth.of(state, recipe, null, { economy: economy() }).worth, 0, 'no way to make it, no worth');
assert.strictEqual(worth({ economy: economy() }, route(0)).worth, 0, 'no demand, nothing of its own: worth nothing');

const quiet = worth({ economy: economy(), offers: [] });
assert(quiet.sale > 0 && quiet.worth > 0, 'funded unmet demand is a gain');
const crowded = worth({ economy: economy(), offers: [offer(50), offer(80), offer(30), offer(10)] });
assert(crowded.sale < quiet.sale, 'more visible sellers share the demand');
assert(crowded.worth < quiet.worth);

for (let deal = 0; deal < 30; deal++) MarketCounters.deal(1463, 22, 156, at - (30 - deal) * 120000, 7, 'Giran', 8);
const traded = worth({ economy: economy(), offers: [] }, route(0));
assert(traded.sale > 0, 'deals on the board are demand without any unmet bid');

const mine = worth({ economy: economy(1500), offers: [offer(40)] });
assert(mine.own >= 0 && mine.hourGain >= mine.sale, 'own use adds to the gain');
const scarce = worth({ economy: economy(1500), offers: [] });
assert(scarce.own > mine.own, 'nobody sells the shots: the whole combat gain of having them counts');
assert(scarce.worth > mine.worth, 'a shortage raises the worth, no separate premium');

const sharp = worth({ economy: economy(0, 1), offers: [] });
const dim = worth({ economy: economy(0, 0), offers: [] });
assert.notStrictEqual(sharp.worth, dim.worth, 'the personal error depends on the understanding');
assert.strictEqual(worth({ economy: economy(0, 1), offers: [] }).worth, sharp.worth, 'the error is stable');

console.log('recipe worth passed');
process.exit(0);
