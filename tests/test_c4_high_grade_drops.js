const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const rewardTables = require('../data/Npcs/Rewards/rewards.json');

// [monster, the author's reward groups, the author's spoil groups, added C4 item ids]:
// B grade recipe scrolls and Scroll: Enchant Armor (Grade A) appended as groups
// after the author's own, which stay as they were.
const added = [
    [134, 3, 1, [4192, 4993]], [137, 3, 1, [4163, 4952, 4999]], [146, 3, 1, [4188]], [161, 3, 1, [3955, 4180]],
    [242, 3, 1, [3034, 4941, 4959]], [243, 3, 1, [1806, 4144, 4184]], [244, 3, 1, [4185]], [245, 3, 1, [4129, 4945, 4999]],
    [246, 3, 1, [4157, 4176, 4969]], [575, 3, 1, [1806, 4145, 4180, 4184]], [576, 3, 1, [4178, 4187]], [597, 3, 1, [4184]],
    [598, 3, 1, [1806]], [620, 3, 1, [4999]], [622, 3, 1, [4988]], [623, 3, 1, [4177]],
    [624, 3, 1, [4154]], [625, 3, 1, [4192]], [627, 3, 1, [4973]], [628, 3, 1, [4988]],
    [629, 3, 1, [5006]], [643, 3, 1, [4126]], [644, 3, 1, [1806, 4142, 4147, 4184]], [645, 3, 1, [4179, 4189]],
    [646, 3, 1, [3034, 4186, 4190]], [647, 3, 1, [4176, 4946]], [648, 3, 1, [4961, 4999]], [649, 3, 1, [4133, 4194, 4970]],
    [650, 3, 1, [4167, 4168]], [652, 3, 1, [4129, 4173, 4998]], [656, 3, 1, [4990]], [657, 3, 1, [4960]],
    [658, 3, 1, [730, 4155]], [666, 3, 1, [3955]], [667, 3, 1, [4127, 4184]], [668, 3, 1, [1806, 4148, 4936]],
    [669, 3, 1, [4186, 4191]], [670, 3, 1, [4129, 4164, 4168]], [671, 3, 1, [4973]], [672, 3, 1, [4991]],
    [673, 3, 1, [4150]], [674, 3, 1, [4157]], [675, 2, 1, [4184]], [678, 3, 1, [4128, 4134]],
    [679, 3, 1, [1806, 4143, 4149, 4186]], [680, 3, 1, [3034, 4441]], [761, 3, 1, [4989]], [771, 3, 1, [4953]],
    [773, 3, 1, [730, 4157]], [12079, 1, 1, [4197]]
];

DataCache.init();
const itemIds = new Set(DataCache.items.map((item) => item.selfId));
let rows = 0;
added.forEach(([mobId, authorRewards, authorSpoils, expectedItemIds]) => {
    const tables = rewardTables.filter((table) => table.selfId === mobId);
    assert.strictEqual(tables.length, 1, `monster ${mobId} must keep one rewards.json table`);
    assert.strictEqual(DataCache.npcRewards.filter((table) => table.selfId === mobId).length, 1,
        `monster ${mobId} must load one reward table`);
    const groups = [...tables[0].rewards.slice(authorRewards), ...tables[0].spoils.slice(authorSpoils)];
    const ids = groups.flatMap((group) => group.items.map((item) => item.selfId)).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, expectedItemIds, `monster ${mobId} must carry exactly the added C4 rows`);
    ids.forEach((id) => assert.ok(itemIds.has(id), `added drop ${id} must have a loaded template`));
    rows += ids.length;
});
assert.strictEqual(added.length, 50);
assert.strictEqual(rows, 92, 'the 90 recipe rows and 2 enchant rows must all be present');

// A drop group keeps the Lisvus chance of each row: overall x share = droplist chance.
const conjurerBatLord = rewardTables.find((table) => table.selfId === 773).rewards;
assert.deepStrictEqual(conjurerBatLord.slice(3), [
    { items: [{ selfId: 730, name: 'Scroll: Enchant Armor (Grade A)', min: 1, max: 1, chance: 100 }], overall: 0.0127 },
    { items: [{ selfId: 4157, name: 'Recipe: Blue Wolf Gaiters', min: 1, max: 1, chance: 100 }], overall: 0.076 }
]);

console.log('C4 high-grade drop rows on rewards.json monsters checks passed');
