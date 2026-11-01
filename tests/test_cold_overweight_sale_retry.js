'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Listing = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const Rules = invoke('GameServer/Items/NpcSellRules');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Errands = invoke('GameServer/Bot/Economy/ColdMarketService');
const Goals = invoke('GameServer/Bot/Goals/GoalService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const ids = [731501, 731502];

(async () => {
    const world = await createWorld(ids.map(id => ({ id, classId: 49, race: 3, level: 15 })), 'overweight-sale-retry');
    try {
        await Database.createAccount('bot_loaded_shaman', 'fixture');
        await Database.execute(["UPDATE characters SET username='bot_loaded_shaman' WHERE id IN (?,?)", ids]);
        await Life.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 361 });
            if (id === ids[0]) {
                await Database.setItem(id, { selfId: 21, name: 'Shirt', amount: 8 });
                await Database.setItem(id, { selfId: 28, name: 'Pants', amount: 7 });
            }
            await Database.setItem(id, { selfId: 2368, name: 'Training Gloves', amount: 1, equipped: true, slot: 14 });
            const ads = [];
            if (id === ids[0]) {
                const bag = await Database.fetchItems(id);
                for (const selfId of [21, 28]) {
                    const item = bag.find(row => row.selfId === selfId);
                    const result = await Database.createAfkTradeShop(id, { kind: 'sell_ad', storeType: 1,
                        town: 'Orc Village', locX: -44600, locY: -112400, locZ: -240,
                        lines: [{ objectId: item.id, selfId, count: selfId === 21 ? 8 : 7, price: 200 }] });
                    assert.equal(result.shop.custodyPolicy, 1, 'the ad leaves its goods in the physical bag');
                    Afk.refreshRecord(result.shop); ads.push(result.shop.id);
                }
            }
            const now = Date.now(), retry = now + 1800000;
            const state = await Life.upsertState({ characterId: id, name: `LoadedShaman${id}`, level: 15,
                phase: 'cold', activity: 'shopping', currentRegion: 'Orc Village', adena: 361,
                loc: { locX: -44600, locY: -112400, locZ: -240 },
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                vitals: { hp: 400, maxHp: 400, mp: 200, maxMp: 200 },
                stats: { classId: 49, generatedCold: true, marketSellRetryAfter: retry,
                    marketReturn: { loc: { locX: -29133, locY: -100191, locZ: -2728 }, regionName: 'Hunting ground' },
                    townVisit: { town: 'Orc Village', reason: 'sell_inventory', completed: true, startedAt: now - 25000 } }, timing: {} }, 'shaman_sale_fixture');
            if (id === ids[0]) {
                assert.equal(Floor.bagFor(state, now)?.action, 'unload', 'surplus armor requires a physical unload');
                const before = await world.amount(id, 57);
                const intent = Population.marketListingIntent(state);
                assert(intent.cleanup, 'a completed visit with a prepared board plan still requires the native unload');
                const saved = { errands: Errands.finishTownErrands, review: Goals.review, reconcile: Market.reconcile };
                // Restocking and choosing the next economic goal are separate
                // boundaries; the complete visit still uses real NPC mutation,
                // persistence and return travel below.
                Errands.finishTownErrands = async row => row;
                Goals.review = async () => null;
                Market.reconcile = async row => ({ state: row });
                let result;
                try {
                    result = { state: await Population.finishColdMarketStep(state, { economyPlan: {} }, null, true,
                        { state, closed: false }, { state, purchased: false }, null) };
                } finally {
                    Errands.finishTownErrands = saved.errands; Goals.review = saved.review; Market.reconcile = saved.reconcile;
                }
                assert.equal(await world.amount(id, 21), 0, 'a current weight floor bypasses the sale retry without a departure marker');
                assert.equal(await world.amount(id, 28), 0);
                assert.equal(await world.amount(id, 2368), 1, 'the equipped weapon stays owned');
                for (const ad of ads) assert.notEqual((await Database.fetchAfkTradeShop(ad))?.status, 'active',
                    'an NPC liquidation retires the conditional offer backed by those goods');
                assert(!Afk.boardIndex().ownerLines(id).some(line => [21, 28].includes(line.selfId)),
                    'the live board cannot advertise the sold physical stock');
                const data = invoke('GameServer/DataCache');
                const value = selfId => Rules.npcBuyPrice(data.items.find(item => item.selfId === selfId).template.price);
                assert.equal(await world.amount(id, 57), before + value(21) * 8 + value(28) * 7, 'the unload pays exact NPC buyback once');
                assert.equal(Floor.bagFor(result.state, now), null, 'the bot can resume hunting after the visit');
                assert.equal(result.state.stats.marketSellRetryAfter, retry, 'the ordinary market retry remains in force');
                assert.equal(result.state.activity, 'traveling', 'the whole visit resumes the original outing after unloading');
                assert.equal(result.state.stats.travel.reason, 'return_after_market');
                await Listing.open({ ...result.state, activity: 'shopping' }, { now: now + 1000 });
                assert.equal(await world.amount(id, 57), result.state.adena, 'a second visit cannot pay for the removed items again');
            } else {
                const result = await Listing.open(state, { now });
                assert.equal(result.reason, 'sell_retry_cooldown', 'a bag without a hard floor still respects the retry');
            }
        }
        console.log('Cold sale retry: current weight floor unloads surplus, preserves equipped gear and exact payout, ordinary retry remains');
    } finally { Life.reset?.(); await world.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
