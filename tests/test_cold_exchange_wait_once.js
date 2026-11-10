'use strict';
// A far bot shopping in Giran whose crystal exchange is ready
// (BotCrystallization.ready and completionKey) waits in town for the
// worker's improving card. Live, the worker chose otherwise for 255 bots:
// no card came and the visit waited one second more on every pass, forever.
// One wait per key a visit: the next pass on the same key ends the visit.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const botId = 730411;
// Great Axe (B) through recipe 457; its C crystals come from a paid D input.
const RECIPE = 457, D_INPUT = 396;
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

(async () => {
    const world = await createWorld([{ id: botId, classId: 0, level: 40 }], 'cold-exchange-wait');
    try {
        await Database.createAccount('bot_exchange_wait', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_exchange_wait', botId]]);
        await Life.init();
        const place = Town.marketTown('Giran').center;
        const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
        // A return needs a catalogue destination, as it does on the server.
        invoke('GameServer/Bot/AI/SpotService').spots = spots;
        const spot = spots.filter(row => row.center)
            .sort((a, b) => Math.hypot(a.center.locX - place.locX, a.center.locY - place.locY)
                - Math.hypot(b.center.locX - place.locX, b.center.locY - place.locY))[0];
        await Database.setItem(botId, { selfId: 57, amount: 1000, slot: 0 });
        await Database.setItem(botId, { selfId: D_INPUT, amount: 1, slot: 0 });
        const recipe = Recipes.resolveByRecipeId(RECIPE);
        await Life.upsertState({ characterId: botId, accountName: 'bot_exchange_wait', name: 'ExchangeWaiter', level: 40,
            phase: 'cold', activity: 'shopping', currentRegion: 'Giran', spotId: null, adena: 1000, loc: place,
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(botId)),
            stats: { classId: 0, generatedCold: true, money: [100, 0, 1000, 0],
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center },
                equipmentPlan: { strategy: 'craft', status: 'active', target: { selfId: recipe.productId, slot: 7 },
                    recipeId: RECIPE, materials: recipe.materials.map(row => ({ ...row })),
                    crystalPreparation: { materials: [{ selfId: D_INPUT, amount: 1 }] }, source: 'wish_network' } },
            timing: { activityStartedAt: Date.now() - 60000, lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
        }, 'exchange_wait_fixture');
        await Afk.init();
        const view = () => {
            const row = Life.cachedState(botId);
            return JSON.stringify({ activity: row.activity, region: row.currentRegion,
                plan: row.stats?.equipmentPlan?.status, bag: row.inventory?.[D_INPUT]?.amount || 0 });
        };

        // No worker answers with an improving card: the first pass waits for it.
        await Population.resolveColdState(Life.cachedState(botId));
        await settle();
        const first = Life.cachedState(botId);
        assert.equal(first.activity, 'shopping', `the first pass waits in town for the exchange card: ${view()}`);
        assert.equal(first.currentRegion, 'Giran');
        assert(Number(first.timing.nextResolveAt) <= Date.now() + 5000, 'the wait is a short one');

        // Still no card: the same exchange does not hold the visit again.
        await Population.resolveColdState(Life.cachedState(botId));
        await settle();
        const second = Life.cachedState(botId);
        assert.notEqual(second.activity, 'shopping', `the visit never ends while the exchange waits: ${view()}`);
        assert.equal(second.inventory?.[D_INPUT]?.amount, 1, 'the paid input is kept for a later card');
        console.log('Cold exchange waits once per key a visit: passed');
    } finally {
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
