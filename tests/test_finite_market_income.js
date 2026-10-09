'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Goals = invoke('GameServer/Bot/Goals/GoalService');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');

async function run() {
    const id = 731094, world = await createWorld([{ id, classId: 1, level: 35 }], 'finite-income');
    try {
        await Life.init();
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100 });
        await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 10 });
        const state = await Life.upsertState({ characterId: id, name: 'FiniteIncome', phase: 'cold',
            activity: 'shopping', level: 35, adena: 100, currentRegion: 'Giran',
            loc: { locX: 83396, locY: 147904, locZ: -3400 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            stats: { classId: 1, shopTown: { town: 'Giran', at: 1 } }, timing: {},
            vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 } }, 'finite_income_test');
        const trip = () => 0; trip.details = () => ({ known: true, hours: .25, fees: 1 });
        const deps = { board: new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)(), spots: [],
            workshop: null, knownRecipes: [], producerRecipes: [], tripCost: trip, knowledgeEnabled: false };
        const context = Economy.forState(state, deps);
        const sale = context.projection.moneyPaths.find(row => row.kind === 'liquidate');
        assert(sale, 'real reachable spare materials offer a finite sale');
        assert.equal(sale.repeatable, false);
        assert.equal(sale.capacityCash, context.buyback(1867) * 10);
        assert.equal(sale.actionHours, .25);
        assert.equal(sale.cashFees, 1);
        assert.equal(sale.town, 'Giran', 'a stored shop town is read as its town name');
        assert.equal(sale.incomePerHour, undefined);
        const candidateOptions = { keptAmounts: {}, preparedReservations: {} };
        for (const patch of [{ reservedAmount: 10 }, { protectedAmount: 10 }, { protected: true },
            { acceptedCustomer: true }, { assignedClan: true }, { available: false }]) {
            const held = { ...state, inventory: { ...state.inventory, 1867: { ...state.inventory[1867], ...patch } } };
            assert.equal(Disposition.saleCandidates(held, candidateOptions).length, 0);
            const heldContext = Economy.forState(held, deps);
            assert.notEqual(heldContext, context, 'protection changes invalidate the existing context');
            assert(!heldContext.projection.moneyPaths.some(row => row.kind === 'liquidate'));
            const unchanged = await Life.applyNpcLiquidation(held, [{ selfId: 1867, count: 10, npcPrice: 10 }]);
            assert.equal(unchanged.adena, 100, 'a stale candidate cannot sell protected stock at receipt');
            assert.equal(await world.amount(id, 1867), 10);
        }
        const unknownTrip = () => Infinity;
        unknownTrip.details = () => ({ known: false, hours: NaN, fees: NaN });
        Economy.reset();
        assert(!Economy.forState(state, { ...deps, tripCost: unknownTrip }).projection.moneyPaths
            .some(row => row.kind === 'liquidate'), 'unknown travel cannot become a free sale');
        const expensiveTrip = () => 1000;
        expensiveTrip.details = () => ({ known: true, hours: .25, fees: 1000 });
        Economy.reset();
        assert(!Economy.forState(state, { ...deps, tripCost: expensiveTrip }).projection.moneyPaths
            .some(row => row.kind === 'liquidate'), 'the bot cannot spend sale proceeds before reaching the seller');
        const options = { now: 100000, errand: null, economy: { ...context,
            network: { ...context.network, activity: { ...sale, funding: true, valueHours: 1, effort: .25 } } } };
        const need = Needs.evaluate(state, options)[0];
        assert.equal(need.type, 'sell_inventory');
        assert.equal(need.plan.marketTown, sale.town);
        await GoalState.set(id, { ...need, status: 'active' });
        const partialState = { ...state, inventory: { ...state.inventory,
            1867: { ...state.inventory[1867], reservedAmount: 7 } } };
        const partial = await Life.applyNpcLiquidation(partialState, [{ selfId: 1867, count: 10, npcPrice: 10 }]);
        assert.equal(await world.amount(id, 1867), 7, 'only the free part of a stale candidate is sold');
        assert.equal(await world.amount(id, 57), 130);
        assert.equal((await Life.applyNpcLiquidation(partial, [{ selfId: 1867, count: 10, npcPrice: 10 }])).adena, 130);
        const released = { ...partial, inventory: { ...partial.inventory,
            1867: { ...partial.inventory[1867], reservedAmount: 0 } } };
        const after = await Life.applyNpcLiquidation(released, [{ selfId: 1867, count: 10, npcPrice: 10 }]);
        assert.equal(await world.amount(id, 1867), 0);
        assert.equal(await world.amount(id, 57), 200);
        assert.equal(after.adena, 200);
        assert.equal((await Life.applyNpcLiquidation(after, [{ selfId: 1867, count: 10, npcPrice: 10 }])).adena, 200);
        Economy.reset();
        assert(!Economy.forState(after, deps).projection.moneyPaths.some(row => row.kind === 'liquidate'));
        const empty = { ...context, network: { ...context.network, activity: null } };
        // A missing preparation holds the old goal; an authoritative empty
        // graph ends it, for individual and batch reviews alike.
        const held = await Goals.review(after, { ...options, economy: { ...empty, intentPending: true } });
        assert.equal(GoalState.snapshot(id).current.status, 'active');
        assert.equal(held, null);
        await Goals.review(after, { ...options, economy: empty });
        assert.equal(GoalState.snapshot(id).current.status, 'abandoned');
        await GoalState.set(id, { ...need, status: 'active' });
        await Goals.reviewBatch([after], { ...options, economy: empty });
        assert.equal(GoalState.snapshot(id).current.status, 'abandoned');
        console.log('PASS native finite projection / reservations / route / receipt / repeated receipt / goal refresh');
    } finally { Economy.reset(); await world.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
