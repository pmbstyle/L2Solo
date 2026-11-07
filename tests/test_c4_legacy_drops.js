const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const rewardTables = require('../data/Npcs/Rewards/rewards.json');

DataCache.init();
function loaded(mobId) {
    const tables = DataCache.npcRewards.filter((table) => table.selfId === mobId);
    assert.strictEqual(tables.length, 1, `monster ${mobId} must load one reward table`);
    return tables[0];
}

// Ol Mahum Guerilla 207 drops the Lisvus droplist rows (fdc7e33), equal to l2hub C4:
// a drop category is one group (overall = category chance, item chance = its share),
// every spoil row its own group.
const guerilla = loaded(207);
assert.deepStrictEqual(guerilla.rewards, [
    { items: [{ selfId: 57, name: 'Adena', min: 298, max: 568, chance: 100 }], overall: 70 },
    { items: [{ selfId: 220, name: 'Crafted Dagger', min: 1, max: 1, chance: 100 }], overall: 0.0188 },
    { items: [
        { selfId: 1865, name: 'Varnish', min: 1, max: 1, chance: 41.50473 },
        { selfId: 1870, name: 'Coal', min: 1, max: 1, chance: 41.50473 },
        { selfId: 1875, name: 'Stone of Purity', min: 1, max: 1, chance: 2.76673 },
        { selfId: 1879, name: 'Cokes', min: 1, max: 1, chance: 6.917095 },
        { selfId: 2152, name: 'Recipe: Enchanted Necklace', min: 1, max: 1, chance: 7.306715 }
    ], overall: 18.5309 }
]);
assert.deepStrictEqual(guerilla.spoils, [
    { items: [{ selfId: 2152, name: 'Recipe: Enchanted Necklace', min: 1, max: 1, chance: 12.0635 }], overall: 100 },
    { items: [{ selfId: 2181, name: 'Recipe: White Tunic', min: 1, max: 1, chance: 6.859 }], overall: 100 },
    { items: [{ selfId: 2263, name: 'Recipe: Dwarven Trident', min: 1, max: 1, chance: 1.064 }], overall: 100 }
]);
const materials = guerilla.rewards[2];
assert.strictEqual(Number(ProgressionRates.dropItemBaseChance(materials, materials.items[0]).toFixed(4)), 7.6912,
    'Varnish drops at the C4 7.69 %');

// Gray Wolf 525: Small Sword at the C4 1.04 %, adena 19-29.
const grayWolf = loaded(525);
assert.deepStrictEqual(grayWolf.rewards.slice(0, 2), [
    { items: [{ selfId: 1, name: 'Short Sword', min: 1, max: 1, chance: 100 }], overall: 1.0393 },
    { items: [{ selfId: 57, name: 'Adena', min: 19, max: 29, chance: 100 }], overall: 70 }
]);

// The high-grade C4 rows sit in their Lisvus category like the rest: Conjurer Bat
// Lord 773 drops Scroll: Enchant Armor (Grade A) at 0.0127 % from its 39.73 % category.
const enchantGroup = loaded(773).rewards.find((group) => group.items.some((item) => item.selfId === 730));
assert.strictEqual(enchantGroup.overall, 39.7293);
assert.strictEqual(Number(ProgressionRates.dropItemBaseChance(enchantGroup,
    enchantGroup.items.find((item) => item.selfId === 730)).toFixed(4)), 0.0127);

// A monster Lisvus has no drop row for keeps its NodeL2 groups (Gremlin 1).
assert.deepStrictEqual(loaded(1).rewards[0],
    { items: [{ selfId: 57, name: 'Adena', min: 7, max: 10, chance: 100 }], overall: 70 });

const itemIds = new Set(DataCache.items.map((item) => item.selfId));
rewardTables.forEach((table) => [...table.rewards, ...table.spoils].forEach((group) => group.items.forEach((item) => {
    assert.ok(itemIds.has(item.selfId), `drop ${item.selfId} of monster ${table.selfId} must have a loaded template`);
})));

console.log('C4 legacy monster drop checks passed');
