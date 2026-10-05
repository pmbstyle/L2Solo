const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const recipeScrolls = require('../data/Items/Others/c4_recipe_scrolls.json');

// The B, A and S recipe scrolls of recipes.csv that no other item file defined.
const expectedIds = [
    4936, 4938, 4939, 4940, 4942, 4943, 4945, 4946, 4947, 4948, 4949, 4950, 4952, 4953, 4954, 4955,
    4956, 4957, 4960, 4961, 4962, 4963, 4964, 4966, 4967, 4969, 4970, 4971, 4972, 4973, 4974, 4976,
    4977, 4978, 4979, 4981, 4983, 4986, 4987, 4988, 4989, 4991, 4992, 4993, 4994, 4995, 4996, 4997,
    4998, 4999, 5002, 5004, 5006, 5007, 5008, 5332, 5334, 5336, 5338, 5340, 5346, 5348, 5350, 5352,
    5354, 5364, 5366, 5368, 5370, 5380, 5382, 5392, 5394, 5404, 5406, 5416, 5418, 5420, 5422, 5424,
    5426, 5428, 5430, 5432, 5438, 5439, 5441, 5445, 5447, 5453, 5458, 5459, 5461, 5465, 5468, 5469,
    5471, 6847, 6849, 6851, 6853, 6855, 6857, 6859, 6861, 6863, 6865, 6867, 6869, 6871, 6873, 6875,
    6877, 6879, 6881, 6883, 6884, 6885, 6887, 6889, 6890, 6891, 6892, 6893, 6895, 6897, 6899, 7580
];

assert.deepStrictEqual(recipeScrolls.map((item) => item.selfId), expectedIds,
    'the file must hold exactly the previously undefined B, A and S recipe scrolls');

DataCache.init();
const loaded = recipeScrolls.map((scroll) => DataCache.items.filter((item) => item.selfId === scroll.selfId));
assert.ok(loaded.every((copies) => copies.length === 1), 'every recipe scroll must be loaded exactly once');

recipeScrolls.forEach((scroll) => {
    const recipe = C4RecipeItems.resolve(scroll.selfId);
    assert.ok(recipe, `recipe scroll ${scroll.selfId} must belong to a recipe`);
    assert.strictEqual(scroll.template.kind, 'Other.Recipe');
    assert.ok(scroll.template.name.startsWith('Recipe: '), `${scroll.selfId} must keep its source name`);
    assert.strictEqual(scroll.etc.stackable, true);
});

assert.deepStrictEqual(recipeScrolls.find((item) => item.selfId === 4936), {
    selfId: 4936,
    template: {
        kind: 'Other.Recipe', name: 'Recipe: Avadon Shield (60%)', class1: 4, class2: 5, mass: 30, price: 10900
    },
    etc: { stackable: true, consumable: false }
}, 'a representative scroll must keep the exact Lisvus weight and price');

console.log('C4 recipe scroll template checks passed');
