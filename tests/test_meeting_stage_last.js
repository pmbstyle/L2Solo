'use strict';
// A cold bot on a sale visit buys its shots from a conditional sell ad (a trade
// meeting). The meeting is pinned to the exact row revision it was staged on, so
// the row must carry the ended visit already and no write of it may follow on
// that pass (the NPC basket, a held-visit save): such a write discards the deal.
// The NPC basket runs on a later pass, after the preparation settled.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const sellerId = 730321, buyerId = 730322;
const SHOT = 1835, SHORT_SWORD = 1;
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

(async () => {
    const world = await createWorld([{ id: sellerId, classId: 0, level: 20 }, { id: buyerId, classId: 0, level: 20 }], 'meeting-stage-last');
    const prepare = Coordinator.requestMeetingPreparation, restockPlan = ShotStock.restockPlan;
    try {
        await Database.createAccount('bot_stage_last', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id IN (?,?)', ['bot_stage_last', sellerId, buyerId]]);
        await Life.init();
        const place = Town.marketTown('Giran').center;
        await Database.setItem(sellerId, { selfId: 57, amount: 1000, slot: 0 });
        await Database.setItem(sellerId, { selfId: SHOT, amount: 3000, slot: 0 });
        await Database.setItem(buyerId, { selfId: 57, amount: 1000000, slot: 0 });
        await Database.setItem(buyerId, { selfId: 736, amount: 10, slot: 0 });
        await Database.setItem(buyerId, { selfId: SHORT_SWORD, amount: 1, equipped: 1, slot: 7 });
        for (const [id, name, activity, stats] of [
            [sellerId, 'StageSeller', 'hunting', { classId: 0, generatedCold: true, money: [100, 0, 1000, 0] }],
            [buyerId, 'StageBuyer', 'shopping', { classId: 0, generatedCold: true, money: [100, 0, 1000, 0], visitEvery: [8, 4],
                townVisit: { town: 'Giran', startedAt: Date.now() - 60000, reason: 'sell_inventory' } }]
        ]) {
            await Life.upsertState({ characterId: id, accountName: 'bot_stage_last', name, level: 20,
                phase: 'cold', activity, currentRegion: 'Giran', adena: id === buyerId ? 1000000 : 1000, loc: place,
                vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats,
                timing: { activityStartedAt: Date.now() - 60000, lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
            }, 'stage_last_fixture');
        }
        // The seller's conditional sell ad: shots far under the NPC price.
        const stack = (await Database.prepareTradeParticipant(sellerId)).inventory.find(row => row.selfId === SHOT);
        await Database.createAfkTradeShop(sellerId, { kind: 'sell_ad', storeType: 1, town: 'Giran', ...place,
            lines: [{ objectId: stack.id, selfId: SHOT, count: 3000, price: 1 }] });
        await Afk.init();
        assert(Afk.ownerRecords(sellerId).some(row => row.kind === 'sell_ad'), 'the shot ad is on the board');

        // The shot need itself is the economy's decision (not under test): the bot wants 100 shots.
        ShotStock.restockPlan = () => ({ needed: true, amount: 100, targetAmount: 100, currentAmount: 0, cost: 100000, npcAmount: 100 });
        // The payer's worker prepares the meeting later; this test settles it by hand.
        let refuse = null;
        Coordinator.requestMeetingPreparation = () => new Promise((resolve, reject) => { refuse = () => reject(Error('trade_meeting_need_changed')); });

        // The visit's earlier errands (a goal purchase) may take a pass of their own.
        for (let pass = 0; pass < 3 && !Meetings.hasPreparation(buyerId); pass++) {
            assert((await Population.resolveColdState(Life.cachedState(buyerId), { precomputedResult: BackgroundResolver.resolveSolo({ state: Life.cachedState(buyerId) }) })).ok, 'the visit pass runs');
            await settle();
        }
        assert.equal(Meetings.hasPreparation(buyerId), true, 'the sale visit staged a meeting for the shots');
        const row = Life.cachedState(buyerId);
        assert.equal(row.stats.townVisit.completed, true, 'the ended visit is on the same row the meeting is pinned to');
        assert.equal(Number(row.inventory[SHOT]?.amount || 0), 0, 'no NPC basket ran on the staging pass');
        assert.equal(Meetings.hasPreparation(buyerId), true, 'the staged deal survives the pass');

        // Refused: the next pass runs the NPC basket, with shots.
        refuse();
        await settle();
        assert.equal(Meetings.hasPreparation(buyerId), false, 'the refused preparation is discarded');
        await Population.resolveColdState(Life.cachedState(buyerId), { precomputedResult: BackgroundResolver.resolveSolo({ state: Life.cachedState(buyerId) }) });
        await settle();
        assert(Number(Life.cachedState(buyerId).inventory[SHOT]?.amount || 0) > 0, 'after the refusal the NPC basket buys the shots');
        console.log('Staged meeting survives its pass: passed');
    } finally {
        Coordinator.requestMeetingPreparation = prepare;
        ShotStock.restockPlan = restockPlan;
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
