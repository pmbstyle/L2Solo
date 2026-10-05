const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const quests = require('../data/Recipes/c4_high_grade_recipe_quests.json');

// The A and S recipe scrolls each Lisvus C4 quest hands out (data only; no quest runs it yet).
const sGradeSet = [6881, 6883, 6885, 6887, 6891, 6893, 6895, 6897, 6899, 7580];
const sealedJewels = [6847, 6849, 6851];
const expected = {
    358: [5364, 5366, 6329, 6331, 6333, 6335, 6337, 6339],
    372: [5368, 5370, 5380, 5382, 5392, 5394, 5404, 5406, 5426, 5428, 5430, 5432],
    375: [5348, 5350, 5352],
    376: [5332, 5334, 5340, 5346, 5354, 5416, 5418, 5424],
    377: [5336, 5338, 5420, 5422],
    617: sGradeSet,
    619: sGradeSet,
    620: sGradeSet,
    621: sealedJewels,
    622: sealedJewels,
    623: sealedJewels
};

DataCache.init();
const templates = new Set(DataCache.items.map((item) => item.selfId));

assert.deepStrictEqual(quests.map((quest) => quest.quest), Object.keys(expected).map(Number));
quests.forEach((quest) => {
    assert.ok(quest.exchanges.length > 0, `quest ${quest.quest} must have an exchange`);
    const recipes = new Set();
    quest.exchanges.forEach((exchange) => {
        assert.ok(exchange.give.length > 0 && exchange.give.every((item) => item.count > 0),
            `quest ${quest.quest} exchanges must name what is handed in`);
        assert.strictEqual(exchange.outcomes.reduce((sum, outcome) => sum + outcome.chance, 0), 100,
            `quest ${quest.quest} outcome chances must cover every turn-in`);
        exchange.outcomes.flatMap((outcome) => outcome.items || []).forEach((item) => {
            if (C4RecipeItems.resolve(item.selfId)) recipes.add(item.selfId);
            assert.ok(templates.has(item.selfId), `reward ${item.selfId} must have a loaded template`);
        });
    });
    assert.deepStrictEqual([...recipes].sort((a, b) => a - b), expected[quest.quest],
        `quest ${quest.quest} must hand out exactly its Lisvus recipe scrolls`);
});

console.log('C4 high-grade recipe quest table checks passed');
