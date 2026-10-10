'use strict';
// Task 4 B3: the main thread executes the card's step only while it still
// holds. Units or accepted incoming that arrived since the decision make a
// purchase wait for the worker's new card (buyPending); a stale craft step and
// a stale wealth craft write nothing; the cache keeps accepted incoming when a
// life-state write rebuilds the snapshot from columns.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const ShotEconomy = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const ShotPolicy = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const owner = 730171, ORE = 1869, restore = [];
function stub(object, key, value) { const prior = object[key]; restore.push(() => object[key] = prior); object[key] = value; }
const lifeRow = async (patch) => ({ ...(await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [owner]]))[0], ...patch });
(async () => {
    const world = await createWorld([{ id: owner, classId: 0, level: 30 }], 'task4-execute-recheck');
    try {
        await Life.init();
        await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        await Database.setItem(owner, { selfId: ORE, name: 'Iron Ore', amount: 5, slot: 0 });
        await Life.upsertState({ characterId: owner, phase: 'cold', activity: 'hunting', level: 30, adena: 100000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(owner)),
            loc: { locX: 0, locY: 0, locZ: 0 }, currentRegion: 'Giran', stats: {} }, 'fixture');
        const prepared = Life.cachedState(owner);
        assert.equal(prepared.inventory[ORE].amount, 5);

        const board = new BoardIndex();
        board.put({ id: 77, ownerId: 99, kind: 'sell_ad', custodyPolicy: 1, revision: 4, storeType: Afk.SELL ?? 1,
            town: 'Giran', lines: [{ lineId: 78, selfId: ORE, count: 2, price: 237 }] });
        stub(Afk, 'boardIndex', () => board);
        stub(Afk, 'offerOf', line => ({ store: { afkTrade: true, conditional: true, storeType: line.storeType,
            shopId: line.recordId, items: [{ selfId: ORE, count: 2, price: 237, afkTradeLineId: 78 }] } }));
        let bought = 0;
        stub(Afk, 'buyFromShop', async () => { bought++; return { pending: true, meetingId: 5 }; });
        const take = { take: [Afk.SELL ?? 1, ORE, 2, 77, 78, 4, 237] };
        const records = await Database.fetchAfkTradeShops(owner);

        // 1. Nothing arrived since the decision: the take runs.
        assert.equal((await Market.executePlan(prepared, take)).meetingId, 5);
        assert.equal(bought, 1, 'a held decision buys');

        // 2. Accepted incoming arrived (a meeting reply row, same revision): wait.
        assert(Life.acceptLifecycleRow(await lifeRow({ acceptedIncoming: { [ORE]: 2 } })));
        assert.deepEqual(Life.cachedState(owner).acceptedIncoming, { [ORE]: 2 });
        assert.equal((await Market.executePlan(prepared, take)).buyPending, true);
        assert.equal(bought, 1, 'accepted incoming since the decision never buys twice');
        // A buy ad for the same item waits too and publishes nothing.
        assert.equal((await Market.executePlan(prepared, { buyAds: [[ORE, 2, 237]] })).buyPending, true);
        assert.deepEqual(await Database.fetchAfkTradeShops(owner), records, 'a filled buy ad is not published');

        // 3. A life-state write rebuilt from columns keeps the cached incoming
        //    (it used to drop it, so the worker re-ordered goods already bought).
        await Life.upsertState({ ...Life.cachedState(owner), activity: 'fighting' }, 'probe_combat');
        assert.deepEqual(Life.cachedState(owner).acceptedIncoming, { [ORE]: 2 }, 'upsertState keeps accepted incoming');
        const withoutField = { ...Life.cachedState(owner), activity: 'hunting' };
        delete withoutField.acceptedIncoming;
        await Life.upsertState(withoutField, 'probe_without_field');
        assert.deepEqual(Life.cachedState(owner).acceptedIncoming, { [ORE]: 2 }, 'a snapshot without the field keeps it');
        // A reply row that carries the field (delivery settled) clears it.
        assert(Life.acceptLifecycleRow(await lifeRow({ acceptedIncoming: {} })));
        assert.deepEqual(Life.cachedState(owner).acceptedIncoming, {}, 'an SQL row with the field is the authority');

        // 4. Units reached the bag since the decision (same revision): wait.
        const fresh = Life.cachedState(owner);
        const realCached = Life.cachedState;
        stub(Life, 'cachedState', id => Number(id) === owner
            ? { ...fresh, inventory: { ...fresh.inventory, [ORE]: { ...fresh.inventory[ORE], amount: 7 } } } : realCached.call(Life, id));
        assert.equal((await Market.executePlan(fresh, take)).buyPending, true);
        assert.equal(bought, 1, 'units in the bag since the decision never buy twice');
        restore.pop()();

        // 5. The card's heldAtDecision is the baseline, not the prepared bag:
        //    5 held now, 3 when the worker decided -> filled since.
        stub(Coordinator, 'economyDecisions', { decided: () => ({ activity: { itemId: ORE, heldAtDecision: 3 } }) });
        assert.equal((await Market.executePlan(fresh, take)).buyPending, true);
        assert.equal(bought, 1, 'the card baseline counts units the core has not seen');
        restore.pop()();

        // 6. A stale craft step (older prepared revision) waits; a fresh one runs.
        let shots = 0;
        stub(ShotPolicy, 'unpackStep', () => ({ recipeId: 1, batches: 1 }));
        stub(ShotEconomy, 'execute', async state => { shots++; return state; });
        const older = { ...fresh, simulation: { ...fresh.simulation, revision: -1 } };
        assert.equal((await Market.executePlan(fresh, { shot: [1] }, { preparedState: older })).buyPending, true);
        assert.equal(shots, 0, 'a stale shot step is not executed');
        await Market.executePlan(fresh, { shot: [1] });
        assert.equal(shots, 1, 'a held shot step is executed');

        // 7. A meeting settles: its goods reach the bag and every settlement
        //    writer replies with the projected SQL row in the same transaction
        //    (TradeMeeting terminal and settleBoardOwner via coldSimulationRow),
        //    which clears the incoming; column-only writes after it never
        //    bring it back, so the bag is not counted twice (heldFor = bag +
        //    incoming). Only a column-only write carrying the settled bag
        //    before that row would count it twice (9); no writer does so.
        const { heldFor } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
        assert(Life.acceptLifecycleRow(await lifeRow({ acceptedIncoming: { [ORE]: 2 } })));
        assert.equal(heldFor(Life.cachedState(owner), ORE), 7, '5 in the bag and 2 in the accepted meeting');
        await Database.setItem(owner, { selfId: ORE, name: 'Iron Ore', amount: 2, slot: 0 });
        const settledBag = Life.inventorySummaryFromItems(await Database.fetchItems(owner));
        assert(Life.acceptLifecycleRow(await lifeRow({ acceptedIncoming: {}, inventorySummary: JSON.stringify(settledBag) })));
        assert.equal(Life.cachedState(owner).inventory[ORE].amount, 7);
        assert.equal(heldFor(Life.cachedState(owner), ORE), 7, 'the settlement row: 7 in the bag, nothing incoming');
        const later = { ...Life.cachedState(owner), activity: 'hunting' };
        delete later.acceptedIncoming;
        await Life.upsertState(later, 'probe_after_settlement');
        assert.equal(heldFor(Life.cachedState(owner), ORE), 7, 'a column-only write after the settlement counts the bag once');

        // 8. A wealth craft whose decision changed writes nothing.
        let writes = 0;
        stub(Life, 'upsertState', async () => { writes++; return null; });
        const opportunity = { exit: { type: 'npc' }, recipe: { mpCost: 0 }, batches: 1, basket: { owned: [], purchases: [] } };
        const stale = await Wealth.execute(fresh, opportunity, { stillPrepared: () => false });
        assert.equal(stale.stale, true);
        assert.equal(stale.reason, 'decision_changed');
        assert.equal(writes, 0, 'a stale wealth craft writes no state');
        assert.equal((await Wealth.execute(fresh, opportunity, { stillPrepared: () => true })).reason, 'state_write_rejected');
        assert.equal(writes, 1, 'a held wealth craft reaches its first write');
        console.log('PASS Task 4 execute recheck: incoming/bag since decision wait, stale shot/wealth write nothing, cache keeps incoming');
    } finally { for (const fn of restore.reverse()) fn(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
