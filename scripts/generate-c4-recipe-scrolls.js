// Recipe scroll templates for every B, A and S grade recipe in data/Recipes/recipes.csv
// that no loaded item file defines yet (the 60%/70% B scrolls and the A and S scrolls).
// Templates come from the pinned Lisvus item XML in the same shape the monster slices use.
const path = require('path');
const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const root = path.resolve(__dirname, '..');
process.chdir(root);
const C4RecipeItems = require(path.join(root, 'src', 'GameServer', 'Items', 'C4RecipeItems'));

const filename = 'c4_recipe_scrolls.json';
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

generateC4MonsterLocation.assertLisvusRevision();
const sourceItems = generateC4MonsterLocation.vendorItems();
const loadedIds = new Set(generateC4MonsterLocation.loadedItems(filename).map((item) => Number(item.selfId)));
const highGrades = new Set(['B', 'A', 'S']);

const scrollIds = Object.values(C4RecipeItems.loadRecipeItems())
    .filter((recipe) => {
        const product = sourceItems.get(recipe.productId);
        if (!product) throw new Error(`Missing Lisvus product template ${recipe.productId}`);
        return highGrades.has(String(product.sets.get('crystal_type') || '').toUpperCase());
    })
    .map((recipe) => recipe.recipeItemId)
    .filter((id) => !loadedIds.has(id))
    .sort((a, b) => a - b);
generateC4MonsterLocation.assertExact(scrollIds, expectedIds, 'recipe scroll ids');

const items = scrollIds.map((id) => {
    const source = sourceItems.get(id);
    if (!source) throw new Error(`Missing Lisvus recipe scroll template ${id}`);
    const item = generateC4MonsterLocation.itemTemplate(source);
    if (item.template.kind !== 'Other.Recipe') throw new Error(`Lisvus item ${id} is not a recipe`);
    return item;
});

generateC4MonsterLocation.writeJson(`data/Items/Others/${filename}`, items);
console.info(`Generated ${items.length} recipe scroll templates.`);
