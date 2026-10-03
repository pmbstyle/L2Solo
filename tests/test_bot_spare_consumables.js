const assert = require('assert');

require('../src/Global');

// H12 with H3: a bot keeps the consumables its class uses and the NPC buys the
// rest, on the cold visit as on the hot one. No bot spends arrows, reads a
// scroll of escape or resurrection, opens a chest with a key or drinks an
// antidote; it drinks healing potions, so it keeps them up to its restock
// target, strongest first. Enchant scrolls, crystals and Adena are not spare.
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
assert.deepStrictEqual(ItemDisposition.healingStockAmounts(state), { 1061: target },
    'the healing stock is kept strongest first up to the restock target');
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
    [[17, 500], [736, 3], [1060, 10], [1061, 30 - target], [1661, 2], [1831, 4]],
    'the cold visit sells arrows, scrolls of escape, keys, antidotes and the potion surplus to the NPC');
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
