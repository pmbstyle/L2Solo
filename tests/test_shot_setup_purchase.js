'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
process.env.L2NODE_PROGRESSION_RATE = 'x50';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const native = require('./helpers/workerEconomyDecision');
(async () => {
    const recipe = Recipes.resolveByRecipeId(21), timestamp = Date.now(), batches = 11;
    const state = { characterId: 910811, accountName: 'bot_shot_setup', name: 'ShotSetup',
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 62,
        adena: 100000000, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
        inventory: Object.fromEntries(recipe.materials.map(row => [row.selfId,
            { selfId: row.selfId, amount: row.amount * 16, stackable: true }])),
        updatedAt: timestamp, timing: {}, simulation: { revision: 1 },
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57,
            exp: invoke('GameServer/DataCache').experience[61],
            shotRecipeDemand: { itemId: recipe.recipeItemId, recipeId: 21, batches, amount: 1, at: timestamp },
            wishFocus: [`resale:${recipe.productId}`, 0, 0], money: [1000, .001, 0, 0] } };
    state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    for (let i = 0; i < 3; i++) state.stats.huntEfficiency = Hunt.record(state,
        { spotId: 'native_setup_hunt', cycleMs: 3600000, adena: 77000, exp: 100000,
            kills: 1, timestamp });
    Market.reset();
    Market.supplyDeal(recipe.productId, 10000, 'Giran', timestamp - 600000);
    Market.supplyDeal(recipe.productId, 10000, 'Giran', timestamp - 300000);
    let rows; Market.publish({ register: (_name, source) => rows = source.allRows(), changed: () => {} });
    const boardRows = [[8001, [8001, 'sell_ad', 1, 910812, 'Giran', 1,
        [[9001, recipe.recipeItemId, 0, 3, 8000, null, 0]], 1, 1, 0]]];
    const input = { timestamp, nativeRoutes: true, recipes: { recipeBook: Codec.pack([20]), knownShotRecipes: [20] },
        tablePages: [{ tables: [
            { name: 'board', from: null, to: 0, full: true, rows: boardRows, removed: [], last: true },
            { name: 'market', from: null, to: 0, full: true, rows: rows.map(row => [row[0], row]), removed: [], last: true }
        ] }] };
    const capture = await native(state, input);
    const root = capture.queue.find(row => row.key === `resale:${recipe.productId}`);
    assert(root, 'the public fixed-store flow supports the native production goal');
    assert.equal(root.object.amount, recipe.productCount * batches, 'the shared graph plans the chosen whole production lot');
    const funded = { ...state, stats: { ...state.stats, ...capture.statsPacket } };
    const point = invoke('GameServer/World/TownRespawn').towns.giran_town;
    const request = { token: 'production-recipe-purchase', actorA: state.characterId, actorB: 910812, seqA: 1, seqB: 1,
        town: 'Giran', point: { locX: point.locX, locY: point.locY, locZ: point.locZ },
        parties: [0, 1].map(() => ({ phase: 'cold', hotAt: 0, revision: 1, sequence: 1,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
        lines: [{ payer: 0, itemId: 99999991, selfId: recipe.recipeItemId, count: 1, price: 8000,
            enchant: 0, adId: 8001, adRevision: 1, certificate: null }] };
    const prepared = await native(funded, { ...input, meetingRequest: request });
    assert.equal(Intent.decode(prepared.request.lines[0].certificate).itemId, recipe.recipeItemId);
    assert.equal(state.inventory[recipe.recipeItemId], undefined, 'preparation grants no recipe');
    // The want lives until its clear event (learned, or the plan drops it), not a clock.
    const aged = await native({ ...state, stats: { ...state.stats,
        shotRecipeDemand: { ...state.stats.shotRecipeDemand, at: timestamp - 3 * 3600000 } } }, input);
    assert.equal(aged.queue.find(row => row.key === `resale:${recipe.productId}`)?.object.amount, recipe.productCount * batches,
        'a recipe want three hours old still plans its production lot');
    const expired = { ...state, stats: { ...state.stats, shotRecipeDemand: null } };
    const fresh = await native(expired, input);
    const expiredRoot = fresh.queue.find(row => row.key === `resale:${recipe.productId}`);
    assert(!expiredRoot || expiredRoot.object.amount <= recipe.productCount,
        'a completed or obsolete setup does not permanently inflate future production quantity');
    const inputState = { ...funded, inventory: { ...funded.inventory,
        1459: { selfId: 1459, amount: 25, stackable: true } }, stats: { ...funded.stats,
        shotRecipeDemand: null, shotCraft: { preparing: { recipeId: 21, productId: 1464, batches, at: timestamp } },
        equipmentPlan: { status: 'deferred', strategy: 'none', reason: 'wish_focus', target: { selfId: 95, slot: 14 },
            recipeId: Recipes.resolveByProductId(95).recipeId,
            materials: [{ selfId: 1459, amount: 353 }], heldInputs: { 1459: 25 } } } };
    inputState.stats = invoke('GameServer/Bot/Situations').raise({ ...inputState.stats }, 'own_preparation');
    const crystalRows = [...boardRows, [8002, [8002, 'sell_ad', 1, 910812, 'Giran', 1,
        [[9002, 1459, 0, 100, 2000, null, 0]], 1, 1, 0]]];
    const inputKit = { ...input, recipes: { recipeBook: Codec.pack([20, 21]), knownShotRecipes: [20, 21] },
        tablePages: [{ tables: [
            { name: 'board', from: null, to: 0, full: true, rows: crystalRows, removed: [], last: true },
            { name: 'market', from: null, to: 0, full: true, rows: rows.map(row => [row[0], row]), removed: [], last: true }
        ] }] };
    const kit = await native(inputState, inputKit);
    const crystalIntent = kit.tradeIntents.find(row => row.itemId === 1459 && row.key === 'resale:1464');
    assert.equal(crystalIntent?.amount, batches, 'production purchases exclude the collected gear crystals');
    const crystalRequest = { ...request, token: 'production-crystal-purchase', lines: [{ ...request.lines[0],
        selfId: 1459, count: batches, price: 2000, adId: 8002 }] };
    const crystalConsent = await native({ ...inputState, stats: { ...inputState.stats, ...kit.statsPacket } },
        { ...inputKit, meetingRequest: crystalRequest });
    assert.equal(Intent.decode(crystalConsent.request.lines[0].certificate).amount, batches);
    const acquired = { ...inputState, inventory: { ...inputState.inventory,
        1459: { ...inputState.inventory[1459], amount: 25 + batches } } };
    const afterInputs = await native(acquired, inputKit);
    assert(!afterInputs.tradeIntents.some(row => row.itemId === 1459 && row.key === 'resale:1464'),
        'newly acquired production crystals satisfy the batch without buying them again');
    console.log('PASS native C shot setup quantity, unknown recipe meeting consent and expired setup');
    Market.reset();
})().catch(error => { console.error(error.stack, error.meetingTrace); process.exitCode = 1; });
