'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const { BoardIndex, rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Shots = require('../src/GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const probe = require('./helpers/workerEconomyDecision');
const originalBoard = Afk.boardIndex;
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
Market.useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure());
const Demand = require('../src/GameServer/Bot/Economy/ShotTradeDemand');

(async () => {
    for (const recipeId of [20, 21, 22, 23, 24]) {
        const recipe = Recipes.resolveByRecipeId(recipeId), board = new BoardIndex();
        const state = { characterId: 910801, accountName: 'bot_pop_shot_income', name: 'ShotSmith',
            phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 80,
            adena: 10000000, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Object.fromEntries(recipe.materials.map(row => [row.selfId,
                { selfId: row.selfId, amount: row.amount, stackable: true }])), updatedAt: Date.now(), timing: {},
            loc: { locX: 83396, locY: 147904, locZ: -3400 },
            stats: { classId: 57, money: [1000, .001, 0, 0] } };
        state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
        const records = [
            { id: 910810, ownerId: 910811, storeType: 3, kind: 'buy_ad', custodyPolicy: 1,
                town: 'Giran', status: 'active', revision: 1,
                lines: [{ id: 9108100, lineId: 9108100, selfId: recipe.productId, count: 100000, price: 100, enchant: 0 }] },
            { id: 910820, ownerId: 910821, storeType: 1, kind: 'shop', custodyPolicy: 0,
                town: 'Giran', status: 'active', revision: 1,
                lines: [{ id: 9108200, lineId: 9108200, selfId: recipe.recipeItemId, count: 1, price: 1, enchant: 0 }] }
        ];
        for (const row of records) board.put(row);
        Afk.boardIndex = () => board;
        const result = await probe(state, { recipeEarning: true, recipes: { recipeBook: Codec.pack([]) },
            boardRows: records.map(row => [row.id, rowOf(row)]) });
        const selected = Policy.unpackStep(Policy.packStep(result.selected));
        assert.equal(selected?.recipeTarget, recipeId, `worker selects the offered grade recipe ${recipeId}`);
        const native = Shots.recheck(state, selected.recipeRoute);
        assert(native && native.profit > 0, `native recheck preserves conditional shot income for ${recipeId}`);
        assert.equal(native.exit.prospective.origin, 'public_bid');
        assert.equal(native.batches, 1, 'an unbacked bid supports a bounded trial');
        if (recipeId === 20 || recipeId === 21) {
            const competitors = [317, 323, recipeId === 20 ? 21 : 20].map((id, at) => ({
                id: 911000 + at, ownerId: 912000 + at, storeType: 3, kind: 'buy_ad', custodyPolicy: 1,
                town: 'Giran', status: 'active', revision: 1, lines: [{ lineId: 913000 + at,
                    selfId: Recipes.resolveByRecipeId(id).productId, count: 100000, price: 10000, enchant: 0 }] }));
            const investing = { ...state, level: 52, stats: { ...state.stats,
                shotRecipeDemand: { itemId: recipe.recipeItemId, at: Date.now(), amount: 1, maxSpend: 1000 } } };
            const wishes = await probe(investing, { nativeRoutes: true, recipes: { recipeBook: Codec.pack([]) },
                boardRows: [...records, ...competitors].map(row => [row.id, rowOf(row)]) });
            assert(wishes.queue.some(row => row.key === `resale:${recipe.productId}`), 'recipe investment has a native earning root');
            assert(wishes.tradeIntents.some(row => row.itemId === recipe.recipeItemId && row.worth >= 1), 'a meeting can certify the recipe purchase through the shared wish graph');
        }
        board.remove(910810);
        assert.equal(Shots.recheck(state, selected.recipeRoute), null, 'withdrawn buyer rejects before spending');
    }
    // A shop is a real earning route even without a BUY ad. Its finite
    // customer forecast comes from completed trades of this item in this town.
    for (const recipeId of [20, 21, 22, 23, 24]) {
        const recipe = Recipes.resolveByRecipeId(recipeId), board = new BoardIndex(), now = Date.now();
        const state = { characterId: 910801, accountName: 'bot_pop_shot_income', name: 'ShotSmith',
            phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 80,
            adena: 10000000, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Object.fromEntries(recipe.materials.map(row => [row.selfId,
                { selfId: row.selfId, amount: row.amount * 20, stackable: true }])), updatedAt: now, timing: {},
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57, money: [1000, .001, 0, 0] } };
        state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
        const scroll = { id: 910820, ownerId: 910821, storeType: 1, kind: 'shop', custodyPolicy: 0,
            town: 'Giran', status: 'active', revision: 1,
            lines: [{ id: 9108200, lineId: 9108200, selfId: recipe.recipeItemId, count: 1, price: 1, enchant: 0 }] };
        board.put(scroll); Afk.boardIndex = () => board;
        Market.reset();
        assert.equal(Demand.forecast(recipe.productId, 'Giran', now), null, 'a listed recipe creates no buyers');
        Market.deal(recipe.productId, 100, 10000, now - 600000, 12, 'Giran', 13);
        Market.deal(recipe.productId, 100, 10000, now - 300000, 14, 'Giran', 15);
        let rows;
        Market.publish({ register: (name, source) => { rows = source.allRows(); }, changed: () => {} });
        if (recipeId === 20) {
            const trip = () => 0;
            trip.details = () => ({ known: true, hours: 0, fees: 0 });
            const economy = { hourAdena: 1000, moneyPrice: .001, gapHorizonHours: 0,
                persona: state.persona, board, trip, worth: () => 0 };
            const ctx = invoke('GameServer/Bot/Economy/MarketPricing').traderContext(state,
                { economy, board, tripCost: trip, timestamp: now });
            const town = invoke('GameServer/Bot/Economy/WealthCraftPolicy').drain(
                invoke('GameServer/Bot/Economy/MarketTownPolicy').chooseTown(state,
                    [{ selfId: recipe.productId, count: recipe.productCount, price: 10 }],
                    { context: ctx, tripCost: trip, timestamp: now }));
            assert.equal(town.town, 'Giran', 'the sale town follows observed shot buyers instead of the D-grade town prior');
            assert.equal(town.reason, 'supported_item_forecast');
        }
        const result = await probe(state, { recipeEarning: true, timestamp: now,
            recipes: { recipeBook: Codec.pack([]) }, tablePages: [{ tables: [
                { name: 'board', from: null, to: 0, full: true, rows: [[scroll.id, rowOf(scroll)]], removed: [], last: true },
                { name: 'market', from: null, to: 0, full: true, rows: rows.map(row => [row[0], row]), removed: [], last: true }
            ] }] });
        const selected = Policy.unpackStep(Policy.packStep(result.selected));
        assert.equal(selected?.recipeTarget, recipeId, `actual worker invests in a shot storefront recipe ${recipeId}`);
        assert.equal(selected.recipeRoute.exit[0], -2, 'listing forecast survives the bounded command codec');
        // The worker decided at `now`. Observed demand decays with time, and
        // a lot that barely fits the forecast (recipe 21: 476 shots against
        // about 480 willing buyers) loses a batch after seconds of a slow run;
        // the executor is checked at the decision moment, not after the probe.
        const atDecision = check => { const clock = Date.now; Date.now = () => now;
            try { return check(); } finally { Date.now = clock; } };
        const native = atDecision(() => Shots.recheck(state, selected.recipeRoute));
        assert(native && native.profit > 0, `native executor accepts the storefront income for ${recipeId}`);
        assert.equal(native.exit.type, 'listing');
        assert.equal(native.exit.repeatable, false, 'observed demand is a forecast, never perpetual funding');
        if (recipeId === 20) {
            // T43 table: buying D shots does not pay for this crafter, so its personal target is
            // the stock it holds; it holds some, and only the rest of the output is for sale.
            const held = 500;
            const producer = { ...state, level: 52, inventory: {
                ...Object.fromEntries(recipe.materials.map(row => [row.selfId,
                    { selfId: row.selfId, amount: row.amount * 64, stackable: true }])),
                [recipe.productId]: { selfId: recipe.productId, amount: held, stackable: true },
                168: { selfId: 168, amount: 1, equipped: true, slot: 7, stackable: false } } };
            const refreshed = await probe(producer, { recipeEarning: true, refreshEconomy: true, timestamp: now,
                recipes: { recipeBook: Codec.pack([20]), knownShotRecipes: [20] }, tablePages: [{ tables: [
                    { name: 'board', from: null, to: 0, full: true, rows: [[scroll.id, rowOf(scroll)]], removed: [], last: true },
                    { name: 'market', from: null, to: 0, full: true, rows: rows.map(row => [row[0], row]), removed: [], last: true }
                ] }] });
            assert(refreshed.selected?.craft?.ownReserve > 0, 'native economy refresh retains the real personal shot reserve');
            const checked = atDecision(() => Shots.recheck(producer, refreshed.selected.craft));
            assert(checked && checked.expectedSold > 0, 'the native batch produces a commercial surplus after its personal reserve');
            assert(checked.expectedSold <= checked.batches * recipe.productCount + held - refreshed.selected.craft.ownReserve,
                'native recheck cannot count personal shots as sold');
        }
        const withOutput = structuredClone(state);
        withOutput.inventory[recipe.productId] = { selfId: recipe.productId, amount: 1000000 };
        assert.equal(Shots.recheck(withOutput, selected.recipeRoute), null, 'unsold own stock prevents more production');
        Market.reset();
        assert.equal(Shots.recheck(state, selected.recipeRoute), null, 'missing current demand rejects before spending');
    }
    console.log('PASS native worker-to-executor shot income and recipe acquisition for D/C/B/A/S');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => { Afk.boardIndex = originalBoard; });
