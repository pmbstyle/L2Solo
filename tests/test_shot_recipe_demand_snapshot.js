const assert = require('assert');

require('../src/Global');
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');

// A dwarf asking for a shot recipe (shotRecipeDemand) is listed among the
// holders of that scroll for the demand index although its bag has none; the
// market snapshot for every other dwarf must still be built.
(async () => {
    const original = LifeState.cachedState;
    const wanting = { characterId: 9101, name: 'Wanting', phase: 'cold', level: 40, activity: 'hunting',
        inventory: { 57: { selfId: 57, amount: 1000 } },
        stats: { shotRecipeDemand: { itemId: 1804, amount: 1, maxSpend: 1000, at: Date.now() } } };
    LifeState.cachedState = (id) => (Number(id) === wanting.characterId ? wanting : original.call(LifeState, id));
    try {
        Workshops.register(wanting);
        Shots._resetForTests();
        const index = await Shots.marketSnapshot(Date.now());
        assert(index.recipeHolders.has(1804), 'recipe holders are computed');
        assert(!index.recipeHolders.get(1804).some(holder => holder.characterId === wanting.characterId),
            'a bot that only wants the scroll does not hold it');
        assert.strictEqual(index.recipeStock.get(1804) || 0, 0, 'no scroll in any bag');
    } finally {
        LifeState.cachedState = original;
        Shots._resetForTests();
    }
    console.log('test_shot_recipe_demand_snapshot passed');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
