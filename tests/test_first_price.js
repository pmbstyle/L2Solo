const assert = require('assert');
const path = require('path');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');

const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} != ${expected}`);
// The hand-made table of test_spot_value_table: spot S (level 18) is rated at 24 for its dps and spoiler.
Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
process.env.L2NODE_PROGRESSION_RATE = 'x1';

// Spot S holds 3 Scavenger Wererats (39) and 1 Sukar Wererat (40), level 18.
const spots = [{ id: 'S', avgLevel: 18, density: 30, npcEntries: [
    { selfId: 39, name: 'Scavenger Wererat', level: 18, count: 3 },
    { selfId: 40, name: 'Sukar Wererat', level: 18, count: 1 }] }];
const reward = DataCache.npcRewards.find((entry) => Number(entry.selfId) === 39);
const dropIds = new Set((reward.rewards || []).flatMap((group) => (group.items || []).map((item) => Number(item.selfId))));
const itemId = 1924;
assert(dropIds.has(itemId), 'the fixture monster drops the test item');
const basePrice = Number(DataCache.items.find((item) => Number(item.selfId) === itemId).template.price);
const yieldPerKill = Planner.itemDropYield(reward, itemId, 'drop', { npcLevel: 18, killerLevel: 24 }).expectedYield;
const kills = 1 / (0.75 * yieldPerKill);
Efficiency.resetLevelBands();
const defaultHour = Efficiency.hourValue({ level: 24, stats: {} });
const first = FirstPrice.firstPrice(itemId, { spots });
assert.strictEqual(first.spotId, 'S');
assert.strictEqual(first.npcId, 39, 'the monster with the larger share of the spot gives more items per hour: it wins');
assert.strictEqual(first.level, 24, 'the level the table rates the spot at');
near(first.kills, kills, 'kills needed = 1 / (share x yield)');
near(first.hours, kills / (defaultHour.perHour / defaultHour.perKill), 'hours at the kill rate of the bots of that level');
const expected = Math.min(basePrice, Math.max(NpcSellRules.npcBuyPrice(basePrice), kills * defaultHour.perKill));
assert.strictEqual(first.price, Math.round(expected), 'price = hours x their hour = kills needed x their income per kill, inside the NPC walls');
assert(first.price >= NpcSellRules.npcBuyPrice(basePrice) && first.price <= basePrice, 'first price within the NPC walls');

// The hour of the level comes from the bots' measured band: a rich band hits the NPC price, a poor one the buy-back.
function band(level, perKill) {
    let bot = { characterId: 7000 + perKill, level, stats: { classId: 1 }, inventory: { 1: { selfId: 1, equipped: true } } };
    for (let i = 0; i < 3; i++) {
        bot = { ...bot, stats: { ...bot.stats, huntEfficiency: Efficiency.record(bot, { spotId: 'x', exp: 100, cycleMs: 60000,
            adena: perKill * 10, loot: 0, kills: 10, timestamp: 1000 }) } };
    }
}
Efficiency.resetLevelBands();
band(24, 1e7);
assert.strictEqual(FirstPrice.firstPrice(itemId, { spots, timestamp: 1000 }).price, basePrice, 'capped at the NPC price');
Efficiency.resetLevelBands();
band(24, 0.001);
assert.strictEqual(FirstPrice.firstPrice(itemId, { spots, timestamp: 1000 }).price, NpcSellRules.npcBuyPrice(basePrice),
    'never below the NPC buy-back');
Efficiency.resetLevelBands();

const notDropped = DataCache.items.find((item) => Number(item.template?.price) > 0 && !dropIds.has(Number(item.selfId))
    && !(DataCache.npcRewards.find((entry) => Number(entry.selfId) === 40)?.rewards || [])
        .some((group) => (group.items || []).some((entry) => Number(entry.selfId) === Number(item.selfId))));
assert.strictEqual(FirstPrice.firstPrice(57, { spots }), null, 'adena has no price');

// No hunting source (group E): crafted = materials + labour; a crystal from
// the cheapest gear per crystal; a no-grade shot at the NPC price; anything
// else at the NPC buy-back. Inside the NPC walls.
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const CraftShop = invoke('GameServer/Bot/Economy/CraftShopService');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const shotD = Recipes.resolveByProductId(1463);
const crafted = FirstPrice.firstPrice(1463, { spots });
assert.strictEqual(crafted.source, 'craft', 'a crafted product nobody drops');
const unitOf = (selfId) => {
    const npc = BotMarketPricing.npcPrice({ selfId });
    return Number.isFinite(npc) ? npc : FirstPrice.firstPrice(selfId, { spots }).price;
};
const materials = shotD.materials.reduce((sum, m) => sum + m.amount * unitOf(m.selfId), 0);
near(crafted.materials, materials / shotD.productCount, 'materials at the NPC price, else at their own first price');
const crafterLevel = [...Array(80).keys()].map((i) => i + 1)
    .find((level) => CraftShop.craftLevelFor({ classId: level >= 40 ? 57 : level >= 20 ? 56 : 53, level }) >= shotD.level);
assert.strictEqual(crafted.crafterLevel, crafterLevel, 'the lowest dwarf able to craft it');
const restMs = Resolver.estimateRestMs({ level: crafterLevel, stats: { classId: crafterLevel >= 40 ? 57 : crafterLevel >= 20 ? 56 : 53 } },
    { hp: 1000, maxHp: 1000, mp: 0, maxMp: 10000 }, { requireMana: true });
const craftHours = shotD.mpCost / (10000 / (restMs / 1000)) / 3600;
near(crafted.labour, craftHours * Efficiency.hourValue({ level: crafterLevel, stats: {} }).perHour / shotD.productCount,
    'labour = the craft time (MP over seated regeneration) at the crafter\'s hour');
const shotBase = Number(DataCache.items.find((item) => Number(item.selfId) === 1463).template.price);
assert.strictEqual(crafted.price, Math.min(shotBase, Math.max(NpcSellRules.npcBuyPrice(shotBase),
    Math.round(crafted.materials + crafted.labour))), 'crafted price inside the NPC walls');
// A crystal: Saber (743 D crystals) drops from monster 65 on the table's spot.
const sabers = [{ id: 'S', avgLevel: 18, density: 30, npcEntries: [{ selfId: 65, name: 'x', level: 18, count: 1 }] }];
const saber = FirstPrice.firstPrice(123, { spots: sabers });
const crystal = FirstPrice.firstPrice(1458, { spots: sabers });
const crystalBase = Number(DataCache.items.find((item) => Number(item.selfId) === 1458).template.price);
assert.strictEqual(crystal.source, 'crystal');
assert.strictEqual(crystal.price, Math.min(crystalBase, Math.max(NpcSellRules.npcBuyPrice(crystalBase), Math.round(saber.price / 743))),
    'a crystal costs the gear it comes from per crystal');
BotMarketPricing.useNpcOfferSnapshot([{ selfId: 1835, price: 7 }]);
assert.deepStrictEqual(FirstPrice.firstPrice(1835, { spots }), { price: 7, source: 'npc' }, 'a no-grade shot at the NPC price');
BotMarketPricing.useNpcOfferSnapshot(null);
const plain = FirstPrice.firstPrice(notDropped.selfId, { spots });
if (plain.source === 'buyback') assert.strictEqual(plain.price, NpcSellRules.npcBuyPrice(Number(notDropped.template.price)),
    'no source at all: the NPC buy-back');
assert.strictEqual(FirstPrice.firstPrice(1804, { spots: [] }).price, NpcSellRules.npcBuyPrice(
    Number(DataCache.items.find((item) => Number(item.selfId) === 1804).template.price)), 'a recipe with no source: the buy-back');

// A recipe chain deeper than the craft depth is cut where it gets too deep:
// the cut price serves the item asked for, but the deep material's own price,
// asked at the top, prices its whole chain (it is not kept from the cut).
{
    const loose = DataCache.items.filter((item) => Number(item.template?.price) > 0
        && String(item.template?.kind || '').startsWith('Other.Recipe')
        && !Number.isFinite(BotMarketPricing.npcPrice({ selfId: item.selfId })))
        .sort((a, b) => Number(a.template.price) - Number(b.template.price));
    const chain = [...loose.slice(0, 6), loose[loose.length - 1]].map((item) => Number(item.selfId));
    assert.strictEqual(new Set(chain).size, 7, 'fixture: seven distinct items');
    const resolve = Recipes.resolveByProductId;
    Recipes.resolveByProductId = (id) => {
        const at = chain.indexOf(Number(id));
        return at >= 0 && at < chain.length - 1
            ? { productId: chain[at], productCount: 1, level: 1, mpCost: 0, materials: [{ selfId: chain[at + 1], amount: 1 }] }
            : resolve(id);
    };
    try {
        FirstPrice.resetCache();
        FirstPrice.cachedFirstPrice(chain[0], { spots: [] });
        const deep = FirstPrice.cachedFirstPrice(chain[5], { spots: [] });
        assert.strictEqual(deep, FirstPrice.firstPrice(chain[5], { spots: [] }).price,
            'a material cut deep in another chain keeps no cut price');
        assert(deep > NpcSellRules.npcBuyPrice(Number(DataCache.items.find((item) => Number(item.selfId) === chain[5]).template.price)),
            'fixture: its full price is above the buy-back the cut gives');
    } finally {
        Recipes.resolveByProductId = resolve;
        FirstPrice.resetCache();
    }
}

Table.useFile();
console.log('First price of drops, crafted items, crystals, shots and the rest, inside the NPC walls, passed');
