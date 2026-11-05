const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Executor = invoke('GameServer/Bot/Goals/GoalExecutor');
const id = 730092;
(async () => {
    const world = await createWorld([{ id, classId: 50, level: 27 }], 'cleanup-existing-shop');
    const reconcile = Market.reconcile;
    let remoteCalls = 0;
    try {
        await Life.init();
        await Database.createAccount('bot_cleanup_shop', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_cleanup_shop', id]]);
        for (const item of [
            { selfId: 57, amount: 100000 }, { selfId: 167, amount: 1 },
            { selfId: 1463, amount: 116 }, { selfId: 17, amount: 939 },
            { selfId: 1864, amount: 5 }
        ]) await Database.setItem(id, { ...item, slot: 0 });
        let rows = await Database.fetchItems(id);
        await Database.updateItemEquipState(id, rows.find(row => row.selfId === 167).id, true, 7);
        const stem = rows.find(row => row.selfId === 1864);
        await Afk.publishBot(id, { storeType: 1, title: 'Stem', town: 'Giran',
            locX: 83396, locY: 147904, locZ: -3400,
            lines: [{ objectId: stem.id, selfId: 1864, count: 5, price: 100, stackable: true }] });
        rows = await Database.fetchItems(id);
        const cleanup = { itemCount: 42, npcOnlySlots: 4, cleanupReason: 'inventory_half_full' };
        const state = await Life.upsertState({ characterId: id, accountName: 'bot_cleanup_shop',
            name: 'OrcCleanupSeller', phase: 'cold', activity: 'shopping', level: 27,
            adena: 100000, currentRegion: 'Giran',
            loc: { locX: 83396, locY: 147904, locZ: -3400 },
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            inventory: Life.inventorySummaryFromItems(rows),
            stats: { classId: 50, generatedCold: true, forcedMarketCleanup: cleanup,
                shopTown: { town: 'Giran', at: 1 },
                marketReturn: { loc: { locX: 41691, locY: 247407, locZ: -6456 },
                    regionName: 'Elven Ruins', spotId: '6_41' } }
        }, 'cleanup_fixture');
        const goal = { type: 'sell_inventory', status: 'active',
            plan: { expectedBenefit: 'market_sale_inventory', marketTown: 'Giran' } };
        assert(Market.canTradeRemotely(state, goal), 'the existing native shop enables remote selling');
        Market.reconcile = async current => {
            remoteCalls++;
            return { state: current, changed: false };
        };
        const intent = Population.marketListingIntent(state, goal);
        const result = await Population.openMarketListing(intent, goal);
        assert.equal(remoteCalls, 0, 'forced physical cleanup cannot be replaced by the existing remote shop');
        assert.equal(result.state.stats.forcedMarketCleanup, null);
        assert(Array.isArray(result.state.stats.marketSellSeen?.items), 'the completed unload defers another half-full trip');
        assert.equal(await world.amount(id, 17), 0, 'the native NPC writer removes the unused arrows');
        assert.equal(await world.amount(id, 1463), 116, 'the Orc keeps every personal D shot during cleanup');
        assert.equal(Executor.beginMarketTravel({ ...result.state, activity: 'hunting',
            stats: { ...result.state.stats, travel: null, marketReturn: null } }, {
            type: 'sell_inventory', status: 'active', target: cleanup,
            plan: { expectedBenefit: 'market_sale_inventory', cleanupReason: 'inventory_half_full' }
        }), null, 'the same half-full reserve cannot immediately start another trip');
        const ordinary = Population.marketListingIntent({ ...result.state, activity: 'shopping' }, goal);
        await Population.openMarketListing(ordinary, goal);
        assert.equal(remoteCalls, 1, 'ordinary shop reviews still use the existing remote sale path');
        console.log('Forced cleanup with an existing native shop checks passed');
    } finally {
        Market.reconcile = reconcile;
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
