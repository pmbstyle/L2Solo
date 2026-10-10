'use strict';
// Task 4 B5 (N7): the bot's lease or simulation revision changes between the
// worker's card and the payment. The coordinator drops the old card (before
// it starts, or inside the payment step): no order, no retry penalty, the goal
// kept, and no refresh of its own (the commit that moved the authority brings
// the next card); a card on the new authority then buys once.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Goals = invoke('GameServer/Bot/Goals/GoalState');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const owner = 730261, ORE = 1869, epoch = 'b5-authority', restore = [];
function stub(object, key, value) { const prior = object[key]; restore.push(() => object[key] = prior); object[key] = value; }
const lifeRow = async (patch) => ({ ...(await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [owner]]))[0], ...patch });
(async () => {
    const world = await createWorld([{ id: owner, classId: 0, level: 30 }], 'task4-b5-authority');
    try {
        await Life.init();
        await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        await Database.setItem(owner, { selfId: ORE, name: 'Iron Ore', amount: 5, slot: 0 });
        await Life.upsertState({ characterId: owner, phase: 'cold', activity: 'hunting', level: 30, adena: 100000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(owner)),
            loc: { locX: 0, locY: 0, locZ: 0 }, currentRegion: 'Giran', stats: {} }, 'fixture');
        const goal = (await Goals.set(owner, { type: 'buy_craft_material', status: 'active',
            target: { itemId: ORE, amount: 2, adena: 237 }, plan: { marketTown: 'Giran', purpose: 'supply' } })).current;

        const board = new BoardIndex();
        board.put({ id: 77, ownerId: 99, kind: 'sell_ad', custodyPolicy: 1, revision: 4, storeType: Afk.SELL ?? 1,
            town: 'Giran', lines: [{ lineId: 78, selfId: ORE, count: 2, price: 237 }] });
        stub(Afk, 'boardIndex', () => board);
        const offer = line => ({ store: { afkTrade: true, conditional: true, storeType: line.storeType,
            shopId: line.recordId, items: [{ selfId: ORE, count: 2, price: 237, afkTradeLineId: 78 }] } });
        stub(Afk, 'offerOf', offer);
        let bought = 0;
        stub(Afk, 'buyFromShop', async () => { bought++; return { pending: true, meetingId: 5 }; });
        const coordinator = new ColdSimulationCoordinator();
        Object.assign(coordinator, { worker: { postMessage() {} }, workerEpoch: epoch, ready: true });
        const refreshes = [];
        coordinator.requestEconomyRefresh = id => { refreshes.push(id); return true; };
        let serial = 0;
        // The worker's card for the state it saw: authority, updatedAt and key.
        const card = state => Protocol.envelope('ready', epoch, { phase: 'economy_plan_ready', characterId: owner,
            authority: Commit.authority(state), economyPlan: { take: [Afk.SELL ?? 1, ORE, 2, 77, 78, 4, 237] },
            economyDecision: { updatedAt: Number(state.updatedAt || 0), key: Decision.stateKey(state) } }, `b5-card-${++serial}`);
        const kept = () => {
            assert.deepEqual(Goals.snapshot(owner).current, goal, 'the goal is kept');
            assert.equal(Life.cachedState(owner).stats?.marketRetryAfter, undefined, 'no retry penalty');
        };

        // 1. The revision moved after the card was made: the card is dropped before it starts.
        const oldCard = card(Life.cachedState(owner));
        const revision = Number(Life.cachedState(owner).simulation?.revision || 0), updatedAt = Life.cachedState(owner).updatedAt;
        assert(Life.acceptLifecycleRow(await lifeRow({ simulationRevision: revision + 1 })));
        assert.equal(Life.cachedState(owner).simulation.revision, revision + 1);
        assert.equal(Life.cachedState(owner).updatedAt, updatedAt, 'only the authority differs from the card');
        await coordinator.onMessage(oldCard, coordinator.worker, epoch);
        assert.equal(bought, 0, 'a card from an older revision pays nothing');
        assert.deepEqual(refreshes, [], 'no refresh: the commit that moved the revision carries the next card');
        kept();

        // 2. The lease changes while the payment is being prepared (after the
        //    coordinator admitted the card): the payment step refuses.
        const leased = await lifeRow({ simulationRevision: revision + 1, simulationLeaseId: 'b5-new-lease' });
        stub(Afk, 'offerOf', line => { Life.acceptLifecycleRow(leased); return offer(line); });
        await coordinator.onMessage(card(Life.cachedState(owner)), coordinator.worker, epoch);
        assert.equal(Life.cachedState(owner).simulation.leaseId, 'b5-new-lease', 'the lease changed mid-payment');
        assert.equal(bought, 0, 'a lease change before the payment pays nothing');
        assert.deepEqual(refreshes, [], 'a deferred trade asks no refresh (only buyPending does)');
        kept();
        restore.pop()();

        // 3. A card made on the new authority buys once.
        await coordinator.onMessage(card(Life.cachedState(owner)), coordinator.worker, epoch);
        assert.equal(bought, 1, 'the new card pays once');
        kept();
        console.log('PASS Task 4 B5 authority bump: old card pays nothing, no penalty, goal kept, new card pays once');
    } finally { for (const fn of restore.reverse()) fn(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
