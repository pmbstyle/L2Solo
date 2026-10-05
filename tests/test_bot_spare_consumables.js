const assert = require('assert');

require('../src/Global');

// H12 with H3: a bot keeps the consumables its class uses and the NPC buys the
// rest, on the cold visit as on the hot one. No bot spends arrows, reads a
// scroll of resurrection, opens a chest with a key or drinks an antidote; it
// drinks healing potions and reads Scrolls of Escape for town trips (step 3.2,
// H12 narrowed 2026-10-05), so it keeps them up to their restock targets.
// Enchant scrolls, crystals and Adena are not spare.
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');

DataCache.init();

const line = (selfId, amount) => ({ selfId, amount, name: DataCache.items.find((entry) => entry.selfId === selfId)?.template?.name });
const state = {
    characterId: 9500001, level: 30, adena: 1000, phase: 'cold', activity: 'shopping',
    stats: { classId: 0, role: 'dps' },
    inventory: Object.fromEntries([
        line(57, 1000), line(17, 500), line(736, 3), line(1661, 2), line(1831, 4),
        line(1060, 10), line(1061, 30), line(956, 1), line(1458, 40)
    ].map((entry) => [String(entry.selfId), entry]))
};

const target = HealingPotionStock.targetAmountFor(state);
assert.deepStrictEqual(HealingPotionStock.stockAmounts(state), { 1061: target },
    'the healing stock is kept strongest first up to the restock target');
// One stock for the sale and the restock: potions at least as strong as the
// one the bot buys at its level (Healing Potion at 30); weaker ones are junk.
const weakStock = { ...state, adena: 100000, inventory: { 57: line(57, 100000), 1060: line(1060, target) } };
assert.deepStrictEqual(HealingPotionStock.stockAmounts(weakStock), {}, 'a weaker potion is no stock at level 30');
assert.strictEqual(HealingPotionStock.restockPlan(weakStock).amount, target, 'the restock buys a full stock of its potion');
const mixed = { ...state, adena: 100000, inventory: { 57: line(57, 100000), 1060: line(1060, 2), 1061: line(1061, 1), 1539: line(1539, 2) } };
assert.deepStrictEqual(HealingPotionStock.stockAmounts(mixed), { 1539: 2, 1061: 1 }, 'stronger potions from loot count, strongest first');
const mixedPlan = HealingPotionStock.restockPlan(mixed);
assert.strictEqual(mixedPlan.amount, target - 3, 'the restock buys what is missing from the stock');
assert.strictEqual(mixedPlan.currentAmount, 1, 'the purchased potion\'s own row is what the purchase writes');
const quick = { ...state, inventory: { 57: line(57, 100000), 1540: line(1540, 20) } };
assert.deepStrictEqual(HealingPotionStock.stockAmounts(quick), {}, 'Quick Healing Potions (drunk only near death) are no restock stock');
assert.strictEqual(new Map(MarketListingPolicy.evaluate(quick, { unlimited: true, states: [] }).npc
    .map((entry) => [entry.selfId, entry.count])).get(1540), undefined, 'but the bot keeps them: it drinks them when nearly dead');
const young = { ...state, level: 15, adena: 100000, inventory: { 57: line(57, 100000), 1060: line(1060, 3) } };
assert.deepStrictEqual(HealingPotionStock.stockAmounts(young), { 1060: 3 }, 'below 20 the Lesser Healing Potion is the stock');
for (const selfId of [17, 736, 1661, 1831, 1060]) {
    assert(ItemDisposition.isSpareConsumable({ selfId }), `${selfId} is a consumable no bot keeps`);
}
// A recipe material (Rope of Magic, a compressed-shot input) and an item the NPC
// pays nothing for (Ancient Adena, a soul crystal) are not junk.
for (const selfId of [57, 956, 1458, 1463, 5192, 5575, 4629]) {
    assert(!ItemDisposition.isSpareConsumable({ selfId }), `${selfId} is not a spare consumable`);
}

const npc = new Map(MarketListingPolicy.evaluate(state, { unlimited: true, states: [] }).npc
    .map((entry) => [entry.selfId, entry.count]));
assert.deepStrictEqual([...npc.entries()].sort((a, b) => a[0] - b[0]),
    [[17, 500], [736, 1], [1060, 10], [1061, 30 - target], [1661, 2], [1831, 4]],
    'the cold visit sells arrows, keys, antidotes and the surplus of potions and Scrolls of Escape to the NPC');
// The hot visit sells first, as the cold one: what it sells to the NPC is not
// stored at the warehouse stop before the sale.
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const armour = DataCache.items.find((entry) => String(entry.template?.kind || '').startsWith('Armor.')
    && String(entry.etc?.rank || 'none') === 'none' && Number(entry.template?.price) > 1000 && Number(entry.template?.price) < 50000);
const actorItem = (selfId, amount) => ({ fetchId: () => selfId, fetchSelfId: () => selfId, fetchAmount: () => amount,
    fetchEquipped: () => false, fetchName: () => 'Item', fetchKind: () => armour.template.kind, fetchRank: () => 'none' });
const hotActor = { fetchId: () => 9500002, backpack: { fetchItems: () => [actorItem(Number(armour.selfId), 1)] } };
assert.strictEqual(BotWarehouse.hasActorDepositCandidates(hotActor, null), true, 'fixture: the armour is a warehouse candidate');
assert.strictEqual(BotWarehouse.hasActorDepositCandidates(hotActor, null, new Map([[Number(armour.selfId), 1]])), false,
    'a piece the visit sells to the NPC is not stored first');
console.log('Bot spare consumables checks passed');
