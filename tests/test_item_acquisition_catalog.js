'use strict';
const assert = require('node:assert/strict');
require('./helpers/isolatedSocialDatabase')('item-source-catalog');
require('../src/Global');
const Catalog = invoke('GameServer/Items/ItemAcquisitionCatalog');
function item(selfId, kind = 'Other.Material', extra = {}) { return { selfId, template: { kind }, ...extra }; }
const input = {
    items: Array.from({ length: 30 }, (_, i) => item(i + 1)),
    npcs: [{ selfId: 100, template: { kind: 'Npc' } }, { selfId: 200, template: { kind: 'Boss' } },
        { selfId: 201, template: { kind: 'Monster' } }, { selfId: 202, template: { kind: 'Monster' } },
        { selfId: 300, template: { kind: 'Monster' } }, { selfId: 400, template: { kind: 'Npc' } }],
    npcSpawns: [{ spawns: [{ selfId: 100, total: 1 }, { selfId: 200, total: 1 }] }],
    offers: [{ npcId: 100, selfId: 1 }, { npcId: 400, selfId: 2 }, { npcId: 200, selfId: 3 }],
    minions: [{ bossId: 200, minionId: 201, max: 1 }, { bossId: 201, minionId: 202, max: 1 },
        { bossId: 300, minionId: 202, max: 1 }],
    npcRewards: [{ selfId: 201, rewards: [{ overall: 100, items: [{ selfId: 4, chance: 1, max: 1 }] }] },
        { selfId: 202, spoils: [{ overall: 100, items: [{ selfId: 5, chance: 1, max: 1 }] }] },
        { selfId: 300, rewards: [{ overall: 100, items: [{ selfId: 6, chance: 100, max: 1 }] }] },
        { selfId: 200, rewards: [{ overall: 100, items: [{ selfId: 24, chance: 100, max: 1 }] }, { overall: 0, items: [{ selfId: 7, chance: 100, max: 1 }] },
            { overall: 100, items: [{ selfId: 8, chance: 0, max: 1 }, { selfId: 9, chance: 100, max: 0 }] }] }],
    recipes: [
        { type: 'dwarven', recipeId: 1, recipeItemId: 4, productId: 10, productCount: 1, successRate: 60, materials: [{ selfId: 1, amount: 2 }, { selfId: 5, amount: 1 }] },
        { type: 'dwarven', recipeId: 2, recipeItemId: 2, productId: 10, productCount: 1, successRate: 100, materials: [{ selfId: 1, amount: 1 }] },
        { type: 'dwarven', recipeId: 3, recipeItemId: 4, productId: 11, productCount: 1, successRate: 100, materials: [{ selfId: 11, amount: 1 }] },
        { type: 'dwarven', recipeId: 4, recipeItemId: 4, productId: 12, productCount: 1, successRate: 100, materials: [{ selfId: 13, amount: 1 }] },
        { type: 'dwarven', recipeId: 5, recipeItemId: 4, productId: 13, productCount: 1, successRate: 100, materials: [{ selfId: 12, amount: 1 }] },
        { type: 'blacksmith_exchange', recipeId: 6, productId: 14, productCount: 1, successRate: 100, materials: [{ selfId: 10, amount: 2 }] },
        { type: 'dwarven', recipeId: 7, recipeItemId: 1, productId: 25, productCount: 1, successRate: 100, materials: [{ selfId: 24, amount: 1 }] }
    ], transformations: [{ inputs: [14], outputs: [15] }, { inputs: [15, 2], outputs: [16] }],
    questItemIds: [19], starterItems: [20], adminShop: [21], inventory: [22], board: [23]
};
input.items[17] = item(18, 'Other.Quest');
input.items[18] = item(19, 'Weapon.Bow');
input.offers.push(...[18, 19].map(selfId => ({ npcId: 100, selfId })));
let result = Catalog.build(input);
for (const id of [1, 4, 5, 10, 14, 15, 24, 25]) assert(result.hasSource(id), `origin/derived ${id}`);
for (const id of [2, 3, 6, 7, 8, 9, 11, 12, 13, 16, 18, 19, 20, 21, 22, 23]) assert(!result.hasSource(id), `unsupported ${id}`);
assert(result.hasNonRaidSource(1), 'ordinary spawned shop creates an ordinary origin');
for (const id of [4, 5, 10, 14, 15, 24, 25]) assert(!result.hasNonRaidSource(id), `raid minion/derived ${id} stays raid-only`);
const bossAlternative = Catalog.build({ ...input, offers: [...input.offers, { npcId: 100, selfId: 24 }] });
assert(bossAlternative.hasNonRaidSource(24));
assert(bossAlternative.hasNonRaidSource(25), 'ordinary alternative of a boss material permits ordinary recipe provenance');
const withOrdinary = Catalog.build({ ...input, npcSpawns: [...input.npcSpawns, { spawns: [{ selfId: 201, total: 1 }] }] });
for (const id of [4, 5, 10, 14, 15]) assert(withOrdinary.hasNonRaidSource(id), `ordinary alternative propagates to ${id}`);
assert(result.allowsRecipe(input.recipes[0]));
assert(!result.allowsRecipe({ ...input.recipes[0], recipeItemId: 2 }), 'recipe id collision cannot forge a supported scroll');
assert(!result.allowsRecipe({ ...input.recipes[0], materials: [{ selfId: 2, amount: 1 }] }), 'recipe id collision cannot forge materials');
assert(!result.allowsRecipe(input.recipes[1]), 'a sourced product does not authorise an unsupported recipe');
assert(result.allowsRecipe(input.recipes[5]), 'exchange does not need a nonexistent recipe scroll');
result = Catalog.build({ ...input, offers: [...input.offers, { npcId: 100, selfId: 12 }, { npcId: 100, selfId: 11 }] });
assert(result.hasSource(13)); assert(result.allowsRecipe(3)); assert(result.allowsRecipe(4)); assert(result.allowsRecipe(5));

const Data = invoke('GameServer/DataCache');
Data.init();
assert(!Object.keys(require.cache).some(path => /\/src\/Database(?:\/|\.js$)/.test(path)),
    'static startup catalog does not load the database or quest execution in workers');
const native = Catalog.prepare();
assert.equal(Catalog.prepare(), native, 'unchanged inputs reuse prepared table');
for (const id of [97, 3, 736, 1835, 1458, 1459, 1460, 1461, 1462, 80, 97, 150, 2131, 2132, 6364, 6724, 6674])
    assert(Catalog.hasSource(id), `ordinary source ${id}`);
for (const id of [1303, 1305, 2605, 4776, 1181, 1182, 1213, 990, 991]) assert(!Catalog.hasSource(id), `control exclusion ${id}`);
// Pinned C4/Lisvus audit controls; this is a regression fixture, not an admission blacklist.
const auditedUnsupported = [
    104, 105, 106, 108, 109, 111, 117, 359, 360, 361, 362, 363, 364, 366, 367, 368, 369, 370,
    371, 372, 373, 375, 384, 385, 386, 387, 389, 402, 403, 404, 405, 406, 407, 408, 409, 410,
    411, 421, 422, 423, 424, 427, 430, 431, 443, 444, 445, 446, 447, 448, 449, 450, 451, 452,
    453, 454, 455, 456, 457, 458, 459, 460, 474, 475, 476, 477, 478, 479, 480, 481, 482, 483,
    484, 501, 502, 504, 505, 506, 507, 508, 509, 510, 511, 513, 514, 515, 516, 518, 519, 520,
    521, 522, 523, 524, 525, 526, 527, 528, 530, 532, 534, 536, 538, 540, 542, 544, 546, 548,
    550, 552, 555, 556, 557, 558, 559, 560, 561, 562, 563, 565, 566, 567, 568, 569, 570, 571,
    573, 574, 575, 576, 577, 579, 580, 581, 583, 584, 585, 586, 587, 589, 591, 592, 593, 594,
    596, 597, 598, 599, 602, 610, 611, 613, 634, 635, 636, 637, 638, 639, 640, 642, 643, 644,
    645, 646, 647, 648, 649, 650, 651, 652, 653, 654, 655, 656, 657, 658, 659, 660, 661, 662,
    663, 664, 665, 666, 667, 668, 669, 670, 671, 672, 674, 857, 859, 860, 861, 863, 865, 866,
    867, 868, 869, 870, 872, 873, 874, 888, 892, 894, 896, 897, 898, 899, 900, 901, 903, 904,
    905, 919, 921, 923, 925, 927, 928, 929, 930, 931, 932, 934, 935, 936, 1506, 1507, 1508, 1509,
    2420, 2421, 2440, 2441, 2442, 2443, 2444, 2445, 2469, 2470, 2471, 2472, 2473, 2474, 2476, 2477, 2478, 2479,
    2482, 2483, 2484, 2488, 2489, 4222, 4223, 4224, 4225, 4226, 4227, 4228, 4229, 4230, 4231, 82, 85, 136,
    137, 138, 139, 140, 141, 146, 147, 149, 165, 207, 209, 211, 214, 237, 244, 245, 246, 247,
    248, 249, 250, 251, 252, 290, 304, 306, 307, 335, 336, 337, 338, 339, 340, 341, 342, 343,
    344, 345, 346, 738, 743, 744, 747, 748, 754, 946, 975, 981, 989, 1142, 1181, 1182, 1213, 1295,
    1296, 1297, 1298, 1299, 1300, 1301, 1302, 1303, 1304, 1305, 1306, 1307, 1376, 1471, 1472, 1510, 1511, 2372,
    2373, 2374, 2507, 2605, 2915, 3026, 3027, 3028, 3029, 3471, 3937, 3938, 3939, 4027, 4028, 4202, 4219, 4220,
    4221, 4862, 4863, 5704, 4720, 4721, 4722, 4756, 4757, 4758, 4764, 4767, 4776, 4782, 4783, 4784, 4785, 4786,
    4787, 4788, 4807, 4808, 4809, 4831, 4832, 4861, 5791, 5792, 5793, 5795, 5796, 5797,
];
assert.equal(auditedUnsupported.length, 392);
for (const id of auditedUnsupported) assert(!Catalog.hasSource(id), `audited unsupported item ${id}`);
for (const id of [97, 3, 736, 1835, 1864]) assert(Catalog.hasNonRaidSource(id), `ordinary native origin ${id}`);
assert(!Catalog.hasNonRaidSource(6724), 'S Tateossian earring native raid-only provenance');
const version = Catalog.revision();
assert.equal(Catalog.revision(), version);
const originals = [Data.items, Data.npcRewards];
try {
    Data.items = [...Data.items, item(900001)];
    Data.npcRewards = [...Data.npcRewards, { selfId: 1, rewards: [{ overall: 100, items: [{ selfId: 900001, chance: 100, max: 1 }] }] }];
    assert(Catalog.hasSource(900001), 'changed native references rebuild');
    assert.notEqual(Catalog.prepare(), native);
    assert(Catalog.revision() > version, 'source token invalidates consumers on replaced input');
} finally { [Data.items, Data.npcRewards] = originals; Catalog.prepare(); }
const registry = require('../src/GameServer/Quest/QuestRegistry');
const activeTools = registry.activeQuests().flatMap(quest => quest.questItems || []).filter(id => {
    const row = Data.items.find(item => Number(item.selfId) === Number(id));
    return /^(Weapon|Armor)\./.test(row?.template?.kind || '');
});
assert.deepEqual([...new Set(registry.equipmentTools())].sort((a, b) => a - b),
    [...new Set(activeTools)].sort((a, b) => a - b), 'passive tool metadata matches actual active native quest handlers');
console.log('Item source graph/recipe/cycle/quest/minion/input-reuse checks passed', Catalog.counts());
