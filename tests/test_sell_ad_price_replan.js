'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Goals = invoke('GameServer/Bot/Goals/GoalState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Opportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Refusals = require('../src/GameServer/Bot/Economy/MeetingPriceRefusals');
const Errands = require('../src/GameServer/Bot/Population/CombinedErrandPolicy');
const ids = [744601, 744602, 744603, 744604, 744605, 744606, 744607],
    [buyer, errandBuyer, seller, raceBuyer, remoteSeller, partialSeller, partialBuyer] = ids;
const itemId = 1867, point = { locX: 83396, locY: 147904, locZ: -3400 };
const dion = { locX: 17000, locY: 145000, locZ: -3000 };

(async () => {
    const world = await createWorld(ids.map(id => ({ id, level: 50 })), 'sell-price-replan');
    const previous = { bestOffer: Opportunity.bestOffer, decided: Coordinator.economyDecisions.decided,
        refresh: Coordinator.requestEconomyRefresh, offerOf: Afk.offerOf };
    try {
        await Database.createAccount('bot_price_replan', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id IN (?,?,?,?,?,?,?)', ['bot_price_replan', ...ids]]);
        await Life.init(); await Goals.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, amount: 1000000, slot: 0 });
            if ([seller, remoteSeller, partialSeller].includes(id)) await Database.setItem(id, { selfId: itemId, amount: 10, slot: 0 });
            await Life.upsertState({ characterId: id, accountName: 'bot_price_replan', name: `Buyer${id}`,
                phase: 'cold', activity: 'shopping', level: 50, adena: 1000000,
                currentRegion: id === remoteSeller ? 'Dion' : 'Giran', loc: id === remoteSeller ? dion : point,
                vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, timing: {},
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                stats: { classId: 0, money: [1000, .001, 0, 0], ...(id === buyer ? {
                    equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: itemId, slot: 7 } }
                } : {}) } }, 'price_replan_fixture');
        }
        await Database.replaceBoardRecords(seller, 'sell_ad', [{ storeType: 1, town: 'Giran', title: 'Expensive', ...point,
            lines: [{ selfId: itemId, count: 10, price: 100, stackable: true }] }], { expected: {} });
        await Afk.init();
        const ad = Afk.ownerRecords(seller).find(row => row.kind === 'sell_ad');
        const remoteItem = (await Database.fetchItems(remoteSeller)).find(row => row.selfId === itemId);
        const remote = await Afk.publishBot(remoteSeller, { kind: 'shop', storeType: 1, town: 'Dion', title: 'Cheaper', ...dion,
            lines: [{ objectId: remoteItem.id, selfId: itemId, name: 'Animal Skin', count: 10, price: 90, stackable: true }] });
        const line = () => Afk.boardIndex().records.get(ad.id)[0];
        const remember = state => Refusals.remember(state, Afk.boardIndex(), { actorA: state.characterId, actorB: seller,
            lines: [{ payer: 0, adId: ad.id, adRevision: ad.revision, selfId: itemId, count: 1, price: 100 }] },
        { selfId: itemId, enchant: 0, units: 1, cost: 100 }, () => true, { fundingDominance: true });

        await Goals.set(buyer, { type: 'upgrade_gear', status: 'active', target: { itemId, amount: 1, adena: 100 },
            plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Giran', valueRate: .01 } });
        const goal = Goals.snapshot(buyer).current, buyerState = Life.cachedState(buyer);
        const offer = Afk.offerOf(line());
        Opportunity.bestOffer = () => offer;
        Coordinator.economyDecisions.decided = () => null;
        const refreshed = [];
        Coordinator.requestEconomyRefresh = id => { refreshed.push(id); return true; };
        remember(buyerState);
        const gear = await Market.tryPurchase(buyerState, goal);
        assert.equal(gear.purchased, false);
        assert.equal(Goals.snapshot(buyer).current.status, 'active', 'a price refusal cannot complete an unbought upgrade');
        assert.equal(gear.state.stats.equipmentPlan?.target?.selfId, itemId, 'the equipment plan survives');
        assert(refreshed.includes(buyer), 'the buyer requests a new economic decision');
        assert.equal((await Database.fetchItems(buyer)).some(row => row.selfId === itemId), false);
        Opportunity.bestOffer = previous.bestOffer;
        const gearAgain = await Market.tryPurchase(Life.cachedState(buyer), goal);
        assert.equal(gearAgain.reason, 'trade_meeting_purchase_price_changed',
            'the real offer search also skips the refused quote without completing the goal');
        assert.equal(Goals.snapshot(buyer).current.status, 'active');

        const errand = { selfId: itemId, amount: 1, town: 'Giran', money: 1000000, maxPrice: 100,
            purpose: 'craft_input', tag: [-5], r: .01, at: Date.now() };
        await Goals.set(errandBuyer, { type: 'upgrade_gear', status: 'active', target: { itemId: 9999, amount: 1 },
            plan: { expectedBenefit: 'market_search_for_gear' } });
        const unrelatedGoal = Goals.snapshot(errandBuyer).current;
        const arrived = await Life.upsertState(Errands.withPending(Life.cachedState(errandBuyer), [errand]), 'price_errand');
        remember(arrived);
        const local = Market.planPurchase(arrived, itemId, 1, { towns: ['Giran'], money: 1000000, npc: false, cost: () => 0 });
        assert.equal(local, null, 'an exact refused quote is excluded during local planning');
        const otherQty = Market.planPurchase(arrived, itemId, 2, { towns: ['Giran'], money: 1000000, npc: false, cost: () => 0 });
        assert.equal(otherQty?.units, 2, 'a refusal for one unit does not reject a different fill');
        Afk.boardIndex().put({ id: 999304, ownerId: 999305, storeType: 1, kind: 'shop', custodyPolicy: 0,
            town: 'Giran', revision: 1, lines: [{ lineId: 999306, selfId: itemId, count: 1, price: 90 }] });
        const mixed = Market.planPurchase(arrived, itemId, 2, { towns: ['Giran'], money: 1000000, npc: false, cost: () => 0 });
        assert.equal(mixed?.units, 1, 'after one cheaper unit, the exact refused one-unit remainder is skipped');
        assert.equal(mixed.lines[0].line.recordId, 999304);
        Afk.boardIndex().remove(999304);
        const alternate = Market.planPurchase(arrived, itemId, 1, { towns: ['Giran', 'Dion'], money: 1000000, npc: false, cost: () => 0 });
        assert.equal(alternate?.town, 'Dion', 'the cheaper available source in another city remains selectable');
        const result = await Market.tryPurchase(arrived, { type: 'market_errand', status: 'active' });
        assert.equal(result.purchased, false);
        assert.equal(Errands.pending(result.state).length, 0, 'the obsolete town-bound errand returns to its originating job');
        assert.deepEqual(Goals.snapshot(errandBuyer).current, unrelatedGoal, 'replanning cannot complete an unrelated goal');
        assert.equal((await Database.fetchItems(errandBuyer)).some(row => row.selfId === itemId), false);
        assert(refreshed.includes(errandBuyer), 'a refused errand also asks the worker to replan');
        const afterReplan = Market.planPurchase(result.state, itemId, 1,
            { towns: ['Giran', 'Dion'], money: 1000000, npc: false, cost: () => 0 });
        assert.equal(afterReplan?.lines[0].line.recordId, remote.id, 'the released job can pick the real alternative');
        const newErrand = { ...errand, town: 'Dion', at: Date.now() };
        const atAlternative = await Life.upsertState({ ...Errands.withPending(result.state, [newErrand]),
            currentRegion: 'Dion', loc: dion, activity: 'shopping' }, 'price_alternative_arrival');
        const purchased = await Market.tryPurchase(atAlternative, { type: 'market_errand', status: 'active' });
        assert.equal(purchased.units, 1, 'the replanned job can complete the actual backed purchase');
        assert.deepEqual(Goals.snapshot(errandBuyer).current, unrelatedGoal, 'finishing the errand cannot complete an unrelated goal');
        assert.equal((await Database.fetchItems(errandBuyer)).find(row => row.selfId === itemId)?.amount, 1);

        await Goals.set(raceBuyer, { type: 'market_errand', status: 'active', target: { itemId, amount: 1 },
            plan: { purpose: 'craft_input', marketTown: 'Giran' } });
        const staleGoal = Goals.snapshot(raceBuyer).current;
        const race = await Life.upsertState(Errands.withPending(Life.cachedState(raceBuyer), [errand]), 'price_errand_race');
        let injected = false;
        Afk.offerOf = function (row, ...args) {
            if (!injected && row.recordId === ad.id) { injected = true; remember(Life.cachedState(raceBuyer)); }
            return previous.offerOf.call(this, row, ...args);
        };
        const raced = await Market.tryPurchase(race, { type: 'market_errand', status: 'active' });
        assert(injected, 'the refusal arrives after the errand plan was selected');
        assert.equal(raced.purchased, false);
        assert.equal(Errands.pending(raced.state).length, 0, 'a late refusal also releases the stale errand');
        assert.equal(Goals.snapshot(raceBuyer).current.status, 'abandoned', 'the refused matching goal is not marked completed');
        assert(refreshed.includes(raceBuyer), 'the late refusal triggers a fresh decision');

        await Goals.set(raceBuyer, { type: 'upgrade_gear', status: 'active', target: { itemId: 9999, amount: 1 } });
        const newGoal = Goals.snapshot(raceBuyer).current;
        assert.equal(await Goals.closeAccepted(raceBuyer, staleGoal, 'completed'), null);
        assert.deepEqual(Goals.snapshot(raceBuyer).current, newGoal, 'a stale completion cannot replace a newer goal');

        // One backed line succeeds before the second line's late refusal.
        // Preserve the real delivery and any unrelated pending errand.
        Afk.offerOf = previous.offerOf;
        const partialStock = (await Database.fetchItems(partialSeller)).find(row => row.selfId === itemId);
        await Afk.publishBot(partialSeller, { kind: 'shop', storeType: 1, town: 'Giran', title: 'Partial', ...point,
            lines: [{ objectId: partialStock.id, selfId: itemId, name: 'Animal Skin', count: 1, price: 90, stackable: true }] });
        const otherErrand = { ...errand, selfId: 1868, amount: 3, town: 'Dion', at: Date.now() };
        const partialState = await Life.upsertState(Errands.withPending(Life.cachedState(partialBuyer),
            [{ ...errand, amount: 2 }, otherErrand]), 'price_partial_race');
        let partialInjected = false;
        Afk.offerOf = function (row, ...args) {
            if (!partialInjected && row.recordId === ad.id) { partialInjected = true; remember(Life.cachedState(partialBuyer)); }
            return previous.offerOf.call(this, row, ...args);
        };
        const partial = await Market.tryPurchase(partialState, { type: 'market_errand', status: 'active' });
        assert(partialInjected, 'the refused second line arrives after the partial physical purchase');
        assert.equal(partial.units, 1);
        assert.equal((await Database.fetchItems(partialBuyer)).find(row => row.selfId === itemId)?.amount, 1);
        assert.equal((await Database.fetchItems(partialBuyer)).find(row => row.selfId === 57)?.amount, 1000000 - 90);
        assert.deepEqual(Errands.pending(partial.state).map(row => row.selfId), [1868], 'only the refused errand is removed');
        assert(refreshed.includes(partialBuyer));
        console.log('PASS rejected seller ad preserves an equipment goal and releases the obsolete market errand');
    } finally {
        Opportunity.bestOffer = previous.bestOffer; Coordinator.economyDecisions.decided = previous.decided;
        Coordinator.requestEconomyRefresh = previous.refresh; Afk.offerOf = previous.offerOf;
        Refusals.clear(); Afk._resetForTests(); await world.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
