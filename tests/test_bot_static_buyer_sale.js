const assert = require('assert');

process.env.L2NODE_PROGRESSION_RATE = 'x1';

delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const { createWorld } = require('./helpers/c4QuestHarness');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Configs = invoke('GameServer/Bot/MerchantStoreConfigs');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');

DataCache.init();

const originalBoard = AfkTrade.boardIndex;
let world;

async function run() {
    world = await createWorld([{ id: 991, level: 10 }], 'static-buyer-sale');
    await LifeState.init();
    for (const item of [{ selfId: 57, name: 'Adena', amount: 100 },
        { selfId: 1864, name: 'Stem', amount: 10 }, { selfId: 1, name: 'Short Sword', amount: 1 }])
        await Database.setItem(991, { ...item, slot: 0 });

    const state = await LifeState.upsertState({
        characterId: 991,
        accountName: 'quests', name: 'MaterialSeller',
        adena: 100,
        phase: 'cold',
        activity: 'shopping',
        level: 10,
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 100 },
            1864: { selfId: 1864, name: 'Stem', amount: 10, kind: 'Other.Material' },
            1: { selfId: 1, name: 'Short Sword', amount: 1, kind: 'Weapon.Sword', rank: 'c' }
        },
        stats: {}
    }, 'static_buyer_seed');

    const board = new BoardIndex();
    board.put({ id: 9991, kind: 'buy_ad', storeType: 3, ownerId: 9992, town: 'Talking Island',
        lines: [{ lineId: 9993, selfId: 1864, count: 10, price: 9999 }] });
    AfkTrade.boardIndex = () => board;
    const buyer = Object.values(Configs).find(store => store.storeType === 3 && store.town === 'Talking Island');
    const authoredLine = buyer.items.find(line => Number(line.selfId) === 1864);
    assert.strictEqual(StaticMerchantPricing.priceFor(buyer, authoredLine), 9999, 'the player sees the board bid');
    const preview = StaticBuyerService.candidatesFor(state, 'Talking Island');
    assert.strictEqual(preview.length, 1, 'the local buyer should accept listed materials');
    assert.strictEqual(preview[0].selfId, 1864);
    assert.strictEqual(preview[0].npcPrice, 80, 'the bot retains its exact authored x1 Stem payout until 3.6');
    assert.strictEqual(StaticBuyerService.bestTownFor(state).town, 'Talking Island', 'market travel should target a town that buys the held material');

    const result = await StaticBuyerService.sell(state, 'Talking Island');
    assert.strictEqual(result.sold, true);
    assert.strictEqual(result.state.inventory['1864'], undefined,
        'accepted materials must be absent from the durable inventory summary');
    assert.strictEqual(result.state.inventory['1'].amount, 1, 'equipment remains available for the player market');
    assert.strictEqual(result.state.adena, 100 + preview[0].npcPrice * 10);
    assert(result.state.stats.lastNpcLiquidation.sold.every(row => row.length === 3 && row.every(Number.isFinite)),
        'liquidation records keep numeric tuples only');
    console.log('Bot static buyer sale checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(async () => {
    AfkTrade.boardIndex = originalBoard;
    LifeState.reset?.();
    if (world) await world.close();
});
