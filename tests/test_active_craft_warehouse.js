'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const Policy = invoke('GameServer/Bot/Economy/CraftWarehousePolicy');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const root = { recipeId: 99001, productId: 300, productCount: 1, successRate: 100, recipeItemId: 4191,
    materials: [{ selfId: 4191, amount: 1 }, { selfId: 4113, amount: 2 },
        { selfId: 1890, amount: 3 }, { selfId: 1459, amount: 4 }] };
const component = { recipeId: 99002, productId: 1890, productCount: 1, successRate: 100, recipeItemId: 4120,
    materials: [{ selfId: 1864, amount: 2 }, { selfId: 1869, amount: 3 }] };
const originalId = Recipes.resolveByRecipeId, originalProduct = Recipes.resolveByProductId;
const originalStations = Shops.publishedStationRecipes;
Recipes.resolveByRecipeId = id => Number(id) === root.recipeId ? root : Number(id) === component.recipeId ? component : originalId(id);
Recipes.resolveByProductId = id => Number(id) === component.productId ? component : originalProduct(id);
Shops.publishedStationRecipes = () => ({ stationByRecipeId: new Map([[root.recipeId, { id: 'root' }],
    [component.recipeId, { id: 'component' }]]) });
function item(id, amount) {
    const data = Data.items.find(row => row.selfId === id);
    return { selfId: id, amount, name: data.template.name, kind: data.template.kind, stackable: data.etc.stackable };
}
const state = { characterId: 990700, level: 55, classId: 3, phase: 'cold', activity: 'hunting', adena: 100000,
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran', timing: {},
    inventory: { 4113: item(4113, 2), 1864: item(1864, 2), 1869: item(1869, 2) },
    stats: { classId: 3, equipmentPlan: { status: 'active', strategy: 'craft', target: { selfId: 300, slot: 14 },
        recipeId: root.recipeId, materials: root.materials, componentRecipes: { 1890: component.recipeId },
        craftProviders: { [root.recipeId]: { publicStation: true }, [component.recipeId]: { publicStation: true } } } } };
let rows = [[1864, 3, 0], [1869, 7, 0]];
Index.useRowSource(() => Index.prepareRow([state.characterId, 1, rows]), () => true);
try {
    assert.equal(Policy.stage(state, Object.values(Index.inventory(state))), null, 'incomplete component stock waits');
    const candidates = Disposition.warehouseCandidates(state);
    assert.equal(candidates.find(row => row.selfId === 1864)?.amount, 2, 'new raw materials are stored');
    assert(!candidates.some(row => row.selfId === 4113), 'key pieces stay in the bag');
    const actor = { fetchId: () => state.characterId, backpack: { fetchItems: () => Object.values(state.inventory) } };
    assert(Warehouse.hasActorDepositCandidates(actor, { ...state, phase: 'hot' }),
        'a visible bot uses its physical backpack for the same storage choice');
    const protectedActor = { fetchId: () => state.characterId, backpack: { fetchItems: () => [state.inventory[1864]] } };
    assert(!Warehouse.hasActorDepositCandidates(protectedActor, { ...state, phase: 'hot', inventory: {
        1864: { ...state.inventory[1864], protected: true } } }), 'a hot inventory refresh preserves explicit protection');
    assert.equal(Warehouse.beginCraftReturn(state), null, 'partial stock cannot cause a warehouse trip');

    rows = [[1864, 4, 0], [1869, 7, 0]];
    const stockFor = invoke('GameServer/Bot/Economy/EconomyContext').stockReader(state, () => 0);
    assert.deepEqual(stockFor(1864, 'power:300:14'), { owned: 2, incoming: 4 },
        'the exact craft accounts for stored units without treating them as executable');
    assert.deepEqual(stockFor(1864, 'resale:1890'), { owned: 0, incoming: 0 },
        'production cannot consume the equipment kit from its warehouse');
    const protectedStock = { ...state, inventory: { ...state.inventory,
        1864: { ...state.inventory[1864], reservedAmount: 5 } } };
    const available = Policy.available(protectedStock, Object.values(Index.inventory(state)));
    assert.equal(available.bag[1864], 0);
    assert.equal(available.warehouse[1864], 1, 'another obligation keeps its remainder in the warehouse too');
    const ready = Policy.stage(state, Object.values(Index.inventory(state)));
    assert.equal(ready?.recipeId, component.recipeId);
    assert.equal(ready.batches, 3, 'withdraw the complete component stage in one visit');
    assert.deepEqual(ready.requests, [{ selfId: 1864, amount: 4, reason: 'craft' },
        { selfId: 1869, amount: 7, reason: 'craft' }]);
    const trip = Warehouse.beginCraftReturn(state, 1800000000000);
    assert.equal(trip?.stats.travel.reason, 'craft_warehouse');
    const grouped = { ...state, partyId: 'test-party', activity: 'grouped' };
    assert.equal(Warehouse.beginCraftReturn(grouped, 1800000000000), null, 'the solo path never moves a party member');
    const groupTrip = Warehouse.beginCraftReturn({ ...grouped, activity: 'hunting' }, 1800000000000, { allowParty: true });
    assert.equal(groupTrip?.stats.travel.reason, 'craft_warehouse');
    const material = invoke('GameServer/Bot/Population/CraftMaterialParty');
    assert.equal(material.remaining(grouped, { targetId: 300, itemId: 1864, requiredTotal: 6 }), 0,
        'material party completion counts the owner’s reserved warehouse stock');
    const PartyBreak = invoke('GameServer/Bot/Population/PartyMarketBreak');
    const party = { partyId: 'test-party', stats: { objective: { objectiveKey: 'test-hunt' } } };
    const ticket = PartyBreak.warehouseDeparture(party, grouped, groupTrip, 1800000000000);
    assert.equal(ticket.stats.partyMarketReturn.cleanupReason, 'craft_warehouse');
    assert.equal(PartyBreak.warehouseDeparture({ ...party, stats: { ...party.stats, warOperation: { id: 'war' } } },
        grouped, groupTrip, 1800000000000), null, 'a warehouse break cannot interrupt war');
    const oldProject = { status: 'deferred', strategy: 'none', reason: 'wish_focus', recipeId: 455,
        target: { selfId: 284, slot: 14 }, heldInputs: { 1864: 1 } };
    const currentPlan = { ...state.stats.equipmentPlan, inputPreparation: oldProject };
    const planningState = { ...state, stats: { ...state.stats, equipmentPlan: currentPlan } };
    const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
    const duplicate = { status: 'deferred', strategy: 'none', reason: 'wish_focus', recipeId: 432,
        target: { selfId: 633, slot: 8 }, heldInputs: { 1867: 21, 4043: 1 } };
    const duplicateChain = { ...duplicate, heldInputs: {}, inputPreparation: { ...duplicate,
        inputPreparation: { ...duplicate, heldInputs: { 4043: 3 }, inputPreparation: {
            ...duplicate, target: { selfId: 633, slot: 9 }, heldInputs: { 1870: 2 } } } } };
    const cleaned = Selection.uniqueCraftProjects(duplicateChain);
    assert.deepEqual(cleaned.heldInputs, { 1867: 21, 4043: 3 }, 'duplicate snapshots merge without multiplying stock');
    assert.equal(cleaned.inputPreparation.target.slot, 9, 'the same item for a different slot remains a distinct project');
    assert.equal(cleaned.inputPreparation.inputPreparation, undefined);
    assert.equal(duplicateChain.inputPreparation.inputPreparation.heldInputs[4043], 3, 'cleanup leaves the original state untouched');
    assert.equal(Selection.uniqueCraftProjects(cleaned), cleaned, 'unchanged chains keep their identity');
    assert.equal(Selection.deferredWishPlan(duplicateChain, {}).inputPreparation.target.slot, 9,
        'normal pausing repairs duplicates already present on the server');
    const buy = Selection.withMarketCraftPreparation(planningState, currentPlan,
        { strategy: 'market', status: 'active', target: currentPlan.target });
    assert.equal(buy.inputPreparation.recipeId, root.recipeId, 'pending purchase retains the current craft');
    assert.equal(buy.inputPreparation.inputPreparation.recipeId, oldProject.recipeId, 'the older project remains behind it');
    const legacyMarket = { ...state.stats.equipmentPlan, strategy: 'market', inputPreparation: undefined };
    const marketPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), originalMarketConsiderable = marketPlanner.considerable;
    marketPlanner.considerable = () => true;
    const recovered = Selection.withMarketCraftPreparation({ ...state, stats: { ...state.stats, equipmentPlan: legacyMarket } }, legacyMarket,
        { strategy: 'market', status: 'active', target: legacyMarket.target });
    marketPlanner.considerable = originalMarketConsiderable;
    assert.equal(recovered.inputPreparation.recipeId, root.recipeId,
        'a saved market plan with recipe inputs recovers its unfinished craft');
    assert.equal(recovered.inputPreparation.heldInputs[4113], 2,
        'recovery protects pieces already collected before the market offer');
    const olderRecipe = originalId(447), olderPart = olderRecipe.materials.find(row => row.selfId !== olderRecipe.recipeItemId);
    const older = { status: 'deferred', strategy: 'none', reason: 'wish_focus', recipeId: olderRecipe.recipeId,
        target: { selfId: olderRecipe.productId, slot: 14 }, heldInputs: {} };
    const newer = { ...buy.inputPreparation, heldInputs: {}, inputPreparation: older };
    for (const status of ['complete', 'blocked']) {
        const terminal = Selection.withRetainedCraftPreparation(state,
            { ...state.stats.equipmentPlan, inputPreparation: older }, { status, reason: 'test_terminal' });
        assert.equal(terminal.inputPreparation?.recipeId, olderRecipe.recipeId,
            `${status} does not discard the older project`);
        const both = Selection.withRetainedCraftPreparation(state,
            { ...state.stats.equipmentPlan, inputPreparation: older }, { status, inputPreparation: { ...buy.inputPreparation, inputPreparation: undefined } });
        assert.equal(both.inputPreparation?.recipeId, root.recipeId);
        assert.equal(both.inputPreparation?.inputPreparation?.recipeId, olderRecipe.recipeId,
            `${status} preserves both independently supplied chains`);
    }
    const equipment = {};
    for (const row of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 3, level: 40 }).items)
        equipment[row.selfId] = { selfId: row.selfId, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [row.slot], slot: row.slot };
    const buying = { ...state, inventory: equipment, stats: { ...state.stats, equipmentPlan: { ...buy, inputPreparation: newer } } };
    const planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), originalConsiderable = planner.considerable;
    planner.considerable = () => true;
    let bids;
    try { bids = invoke('GameServer/Bot/Economy/TradeIntent').retainedProjectIntents(buying, { moneyPrice: 1 }, () => 1); }
    finally { planner.considerable = originalConsiderable; }
    assert(bids.some(row => row.itemId === 4113 && row.recipeId === root.recipeId), 'current pending craft keeps its piece order');
    assert(bids.some(row => row.itemId === olderPart.selfId && row.recipeId === olderRecipe.recipeId), 'older project also keeps its piece order');
    const clanPlan = { ...state.stats.equipmentPlan, clanGoal: { clanId: 42, goalKey: 'clan:42:gear' },
        craftProviders: { [root.recipeId]: { characterId: state.characterId, known: true } } };
    const clanState = { ...state, stats: { ...state.stats, equipmentPlan: clanPlan } };
    const Trade = invoke('GameServer/Bot/Economy/TradeIntent');
    const activePersonal = { ...buying, stats: { ...buying.stats, equipmentPlan: {
        status: 'active', strategy: 'craft', target: { selfId: olderRecipe.productId, slot: 14 },
        recipeId: olderRecipe.recipeId, craftProviders: { [olderRecipe.recipeId]: { publicStation: true } }
    } } };
    planner.considerable = () => true;
    try {
        const needs = Trade.retainedProjectIntents(activePersonal, { moneyPrice: 1 }, () => 100);
        assert(needs.some(row => row.itemId === olderPart.selfId), 'an active B project keeps its piece need even when another wish is selected');
        assert(!needs.some(row => row.itemId === olderRecipe.recipeItemId), 'a public station never requests a recipe scroll');
        const network = { quantityPrepared: true, moneyPrice: 1, queue: [{ key: 'power:2384:10',
            object: { itemId: 2384 }, valueHours: 1, ratio: 1, plan: { missingAmount: 1, requirements: [
                { key: `item:${olderPart.selfId}`, amount: 1, plan: { missingAmount: 1, kind: 'buy', sourceType: 'afk' } }
            ] } }] };
        const shared = Trade.project(activePersonal, network, null, () => 100, 8).find(row => row.itemId === olderPart.selfId);
        assert.equal(shared?.amount, olderPart.amount, 'a one-unit wish cannot shrink the separately justified craft order');
        assert.equal(shared?.key, `power:${olderRecipe.productId}:14`, 'the larger quantity keeps its real project certificate');
        let chain = null;
        for (const id of [457, 455, 447, 441, 453, 439, 443, 445]) {
            const recipe = originalId(id);
            chain = { status: 'deferred', strategy: 'none', reason: 'wish_focus', recipeId: id,
                target: { selfId: recipe.productId, slot: 14 }, craftProviders: { [id]: { publicStation: true } },
                heldInputs: {}, inputPreparation: chain };
        }
        const many = { ...activePersonal, inventory: {}, stats: { ...activePersonal.stats, equipmentPlan: {
            status: 'active', strategy: 'direct_drop', target: { selfId: 76, slot: 7 }, inputPreparation: chain
        } } };
        const shots = { quantityPrepared: true, moneyPrice: 1, queue: [{ key: 'stock:shots', object: { itemId: 1463 },
            valueHours: 1, ratio: 1, plan: { missingAmount: 1, requirements: [
                { key: 'item:1463', amount: 1, plan: { missingAmount: 100, kind: 'buy', sourceType: 'afk' } }
            ] } }] };
        const limited = Trade.project(many, shots, null, () => 100, 8);
        assert.equal(limited.length, 8);
        assert.equal(limited[0].itemId, 1463, 'eight saved projects cannot displace the current shot need');
        const equipped = { ...activePersonal, inventory: { ...activePersonal.inventory,
            [olderRecipe.productId]: { selfId: olderRecipe.productId, amount: 1, equipped: true, equippedSlots: [14], slot: 14 } } };
        assert(!Trade.retainedProjectIntents(equipped, { moneyPrice: 1 }, () => 100).some(row => row.itemId === olderPart.selfId),
            'equipping the finished item retires the part need');
        const reserved = { ...activePersonal, inventory: { ...activePersonal.inventory,
            [olderPart.selfId]: { selfId: olderPart.selfId, amount: olderPart.amount, reservedAmount: olderPart.amount } } };
        assert.equal(Trade.retainedProjectIntents(reserved, { moneyPrice: 1 }, () => 100)
            .find(row => row.itemId === olderPart.selfId)?.amount, olderPart.amount,
        'pieces reserved for another obligation do not satisfy this craft');
        const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
        const board = new BoardIndex(), record = {}, now = 1800000000000;
        const review = require('../src/GameServer/Bot/Population/CraftMarketReview');
        const candidate = { ...activePersonal, activity: 'hunting', stats: { ...activePersonal.stats, money: [1, 1, 0, 0] } };
        assert.equal(review.personalBidDue(candidate, record, now, board), false, 'the initial reviews are staggered');
        const firstReview = record.craftBidReviewAt;
        assert(firstReview >= now && firstReview < now + 900000);
        assert.equal(review.personalBidDue(candidate, record, firstReview, board), true,
            'a missing piece with no order gets a natural review');
        assert.equal(review.personalBidDue(candidate, record, firstReview + 1, board), false,
            'an unsuccessful review cannot spin');
        board.put({ id: 880, ownerId: candidate.characterId, storeType: 3, kind: 'buy_ad', town: 'Giran',
            lines: [{ lineId: 881, selfId: olderPart.selfId, count: olderPart.amount, price: 100 }] });
        assert.equal(review.personalBidDue(candidate, record, firstReview + 900000, board), false,
            'a sufficient standing bid suppresses an unnecessary replan');
        const retainedOnly = { ...candidate, stats: { ...candidate.stats, equipmentPlan: {
            status: 'active', strategy: 'direct_drop', target: { selfId: 76, slot: 7 }, inputPreparation: older
        } } };
        const retainedRecord = {}, retainedBoard = new BoardIndex();
        assert.equal(review.personalBidDue(retainedOnly, retainedRecord, now, retainedBoard), false);
        assert.equal(review.personalBidDue(retainedOnly, retainedRecord, retainedRecord.craftBidReviewAt, retainedBoard), true,
            'a missing standing order is recovered even after switching to another goal');
        const behindClan = { ...candidate, stats: { ...candidate.stats, equipmentPlan: { ...clanPlan, inputPreparation: older } } };
        const clanRecord = {};
        assert.equal(review.personalBidDue(behindClan, clanRecord, now, retainedBoard), false);
        assert.equal(review.personalBidDue(behindClan, clanRecord, clanRecord.craftBidReviewAt, retainedBoard), true,
            'a clan objective cannot suppress the personal project behind it');
        assert.equal(review.personalBidDue({ ...behindClan, stats: { ...behindClan.stats, equipmentPlan: clanPlan } }, {}, now, retainedBoard), false,
            'a clan objective alone does not schedule a personal review');
    } finally { planner.considerable = originalConsiderable; }
    const clanBids = Trade.retainedProjectIntents(clanState, { moneyPrice: 1 }, () => 100);
    assert(clanBids.some(row => row.itemId === root.recipeItemId && row.amount === 1),
        'a clan crafter keeps a standing recipe request while another goal is active');
    const quoted = Trade.retainedProjectIntents(clanState, { moneyPrice: 1 }, id => id === root.productId ? 1000 : 100,
        { list: (id, side) => id === root.recipeItemId && side === 1
            ? [{ ownerId: 42, price: 500, count: 1 }] : [] });
    assert.equal(quoted.find(row => row.itemId === root.recipeItemId)?.worth, 500,
        'a needed clan scroll can follow an available quote, bounded by the finished item value');
    assert(Trade.meetingPurchase({ quantityPrepared: true, moneyPrice: 1, queue: [] }, quoted,
        { selfId: root.recipeItemId, count: 1, price: 500, town: 'Giran' }, clanState),
        'the same current quote authorizes a meeting for the retained recipe');
    assert.equal(Trade.meetingPurchase({ quantityPrepared: true, moneyPrice: 1, queue: [] }, quoted,
        { selfId: root.recipeItemId, count: 1, price: 501, town: 'Giran' }, clanState), null,
        'a retained project cannot authorize a more expensive meeting');
    {
        const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
        const board = new BoardIndex();
        board.put({ id: 810, ownerId: 42, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, revision: 1, town: 'Giran',
            lines: [{ lineId: 811, selfId: root.recipeItemId, count: 1, price: 500 }] });
        const offerState = { ...clanState, activity: 'hunting', phase: 'cold', adena: 10000,
            stats: { ...clanState.stats, money: [100, .01, 0, 0],
                equipmentPlan: { ...clanPlan, next: { itemId: root.recipeItemId, kind: 'material_market' } } } };
        const trip = () => 0; trip.details = () => ({ known: true, fees: 10, hours: 0 });
        const econ = { network: { quantityPrepared: true, moneyPrice: .01, queue: [], activity: null }, trip,
            worth: id => id === root.productId ? 1000 : 100 };
        const Choice = require('../src/GameServer/Bot/Economy/ReadyTradeChoice');
        assert.deepEqual(Choice.clanCraftPurchase(offerState, econ, board), [1, root.recipeItemId, 1, 810, 811, 1, 500],
            'the current clan recipe quote may be purchased while another wish is active');
        const partFirst = { ...offerState, stats: { ...offerState.stats,
            equipmentPlan: { ...offerState.stats.equipmentPlan, next: { itemId: 4113, kind: 'material_drop' } } } };
        assert.deepEqual(Choice.clanCraftPurchase(partFirst, econ, board), [1, root.recipeItemId, 1, 810, 811, 1, 500],
            'a recipe can be bought while the bot pursues a different key input');
        const review = require('../src/GameServer/Bot/Population/CraftMarketReview');
        assert.equal(review.clanInputDue(partFirst, {}, 1800000000000, board), true,
            'the indexed review sees a recipe offer while the selected next input is a piece');
        assert.equal(review.clanInputDue(partFirst, { clanMarketReviewAt: 1800000000000 }, 1800000000001, board), false,
            'clan market reviews are rate limited');
        const station = { ...partFirst, stats: { ...partFirst.stats, equipmentPlan: { ...partFirst.stats.equipmentPlan,
            craftProviders: { [root.recipeId]: { publicStation: true } } } } };
        assert.equal(review.clanInputDue(station, {}, 1800000000000, board), false,
            'a public station does not schedule a recipe purchase');
        const twoTowns = new BoardIndex();
        twoTowns.put({ id: 820, ownerId: 43, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, revision: 1, town: 'Elven Village',
            lines: [{ lineId: 821, selfId: root.recipeItemId, count: 1, price: 100 }] });
        twoTowns.put({ id: 830, ownerId: 44, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, revision: 1, town: 'Giran',
            lines: [{ lineId: 831, selfId: root.recipeItemId, count: 1, price: 200 }] });
        const route = town => town === 'Giran' ? { known: true, fees: 10, hours: 0 } : { known: false };
        const econTwo = { ...econ, trip: Object.assign(() => 0, { details: route }) };
        assert.deepEqual(Choice.clanCraftPurchase(partFirst, econTwo, twoTowns), [1, root.recipeItemId, 1, 830, 831, 1, 200],
            'an unreachable cheaper offer does not suppress the reachable recipe');
        const consent = Trade.project(partFirst, econ.network, null, econ.worth, 40, twoTowns, route);
        assert(Trade.meetingPurchase(econ.network, consent,
            { selfId: root.recipeItemId, count: 1, price: 200, town: 'Giran' }, partFirst),
            'the meeting recomputes the same reachable quote and accepts its price');
        const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
        const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
        const Survival = invoke('GameServer/Bot/Population/SurvivalFloor');
        const previous = [Listing.traderContext, Listing.evaluate, Survival.forState];
        try {
            Listing.traderContext = () => ({}); Listing.evaluate = () => ({ listings: [], answers: [] });
            Survival.forState = () => null;
            const cursor = Plan.prepare(offerState, econ, { board });
            let result; do { result = cursor.next(); } while (!result.done);
            assert.deepEqual(result.value.take, [1, root.recipeItemId, 1, 810, 811, 1, 500],
                'the worker economy plan actually sends the exact clan recipe offer to the meeting owner');
        } finally { [Listing.traderContext, Listing.evaluate, Survival.forState] = previous; }
        assert.equal(Choice.clanCraftPurchase({ ...offerState, adena: 400 }, econ, board), null,
            'the actual wallet still limits the purchase');
        const unknown = () => 0; unknown.details = () => ({ known: false });
        assert.equal(Choice.clanCraftPurchase(offerState, { ...econ, trip: unknown }, board), null,
            'an unknown route cannot launch a meeting');
        assert.equal(Choice.clanCraftPurchase({ ...offerState, inventory: { ...offerState.inventory,
            [root.recipeItemId]: item(root.recipeItemId, 1) } }, econ, board), null,
            'a delivered recipe cannot be bought twice');
    }
    const received = { ...clanState, inventory: { ...clanState.inventory, [root.recipeItemId]: item(root.recipeItemId, 1) } };
    assert(!Trade.retainedProjectIntents(received, { moneyPrice: 1 }, () => 100).some(row => row.itemId === root.recipeItemId),
        'the recipe bid retires when the physical scroll arrives');
    const deferred = { ...newer, inputPreparation: undefined };
    const pausedRoot = { ...buying, stats: { ...buying.stats, equipmentPlan: deferred } };
    planner.considerable = () => true;
    try { assert(Trade.retainedProjectIntents(pausedRoot, { moneyPrice: 1 }, () => 100)
        .some(row => row.itemId === 4113), 'a deferred root keeps its own key-material request'); }
    finally { planner.considerable = originalConsiderable; }
    {
        const BuyAds = invoke('GameServer/Bot/Economy/BuyAdPolicy');
        const actor = { ...pausedRoot, adena: 10000, stats: { ...pausedRoot.stats, money: [100, .01, 0, 0] } };
        const ads = [{ selfId: 4113, count: 2, price: 100, storeType: 3 }];
        planner.considerable = () => true;
        try {
            const merged = BuyAds.keepRetainedBids(actor, ads, [{ selfId: 1864, count: 1, price: 10 }], .01);
            assert.deepEqual(merged.map(row => row.selfId), [1864, 4113],
                'the current need and a still-needed standing order both reach publication');
            assert.equal(merged[1].count, 2);
            const partial = BuyAds.keepRetainedBids(actor, ads, [{ selfId: 4113, count: 1, price: 100 }], .01);
            assert.equal(partial[0].count, 2, 'a smaller competing quote cannot shrink the still-needed standing order');
            const cheaper = { selfId: 4113, count: 1, price: 50, purchaseCap: 50,
                intent: { valueRate: .01, amount: 1, price: 50 } };
            const repriced = BuyAds.keepRetainedBids(actor, ads, [cheaper], .01);
            assert.deepEqual(repriced, [cheaper], 'a larger old bid cannot override the fresh purchase cap');
            assert.deepEqual(BuyAds.keepRetainedBids(actor, ads, repriced, .01), [cheaper],
                'the cap survives the second retention pass before publication');
            const townAds = [{ ...ads[0], kind: 'buy_ad', town: 'Giran' }];
            const ready = BuyAds.retainedLines(actor, repriced, townAds, 'Giran');
            assert.equal(ready[0].price, 50, 'quantity reconciliation cannot restore the old price');
            assert.equal(ready[0].purchaseCap, 50, 'publication receives the fresh cap to reprice the old ad');
            const allowed = BuyAds.keepRetainedBids(actor, ads,
                [{ selfId: 4113, count: 1, price: 100, purchaseCap: 110, survivalCost: 25 }], .01);
            assert.equal(allowed[0].count, 2, 'a larger still-valid bid keeps its quantity');
            assert.equal(allowed[0].purchaseCap, 110, 'a retained bid keeps the fresh purchase cap');
            assert.equal(allowed[0].survivalCost, 25, 'a retained bid keeps the fresh survival tranche');
            assert.equal(BuyAds.keepRetainedBids({ ...actor, adena: 100 }, ads, [], .01).length, 0,
                'an unaffordable order is not protected');
            assert.equal(BuyAds.keepRetainedBids({ ...actor, inventory: { ...actor.inventory, 4113: item(4113, 2) } }, ads, [], .01).length, 0,
                'an order may retire once its pieces arrive');
        } finally { planner.considerable = originalConsiderable; }
    }
    {
        const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
        const board = new BoardIndex();
        board.put({ id: 901, ownerId: state.characterId, storeType: 3, kind: 'buy_ad', town: 'Giran',
            lines: [{ lineId: 902, selfId: 4113, count: 2, price: 100 }] });
        const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
        const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
        const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
        const BuyAds = invoke('GameServer/Bot/Economy/BuyAdPolicy');
        const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
        const saved = [Listing.traderContext, Listing.evaluate, Needs.evaluate, BuyAds.linesFor, BuyAds.goalMoney, Town.chooseTown];
        try {
            Listing.traderContext = () => ({});
            Listing.evaluate = () => ({ listings: [], answers: [] });
            Needs.evaluate = () => [];
            BuyAds.linesFor = () => []; // the current market quote could not be prepared
            BuyAds.goalMoney = () => 0;
            Town.chooseTown = function* () { return { town: 'Giran' }; };
            planner.considerable = () => true;
            const run = actor => {
                const it = Plan.prepare(actor, { network: { moneyPrice: 1 }, watchList: [], intentPending: false },
                    { board, preparedCraft: null });
                let result; do { result = it.next(); } while (!result.done);
                return result.value;
            };
            assert.equal(run(pausedRoot).buyAds?.[0]?.[0], 4113,
                'a temporary pricing failure carries the still-needed standing piece bid');
            assert.deepEqual(run({ ...pausedRoot, inventory: { ...pausedRoot.inventory, 4113: item(4113, 2) } }).buyAds, [],
                'the same bid may retire after the required pieces arrive');
        } finally {
            [Listing.traderContext, Listing.evaluate, Needs.evaluate, BuyAds.linesFor, BuyAds.goalMoney, Town.chooseTown] = saved;
            planner.considerable = originalConsiderable;
        }
    }
    const visited = { ...state, stats: { ...state.stats, craftWarehouseVisit: trip.stats.craftWarehouseVisit } };
    assert.equal(Warehouse.beginCraftReturn(visited, 1800000000001), null, 'an unchanged failed visit cannot spin');
    const changedBag = { ...visited, inventory: { ...visited.inventory, 1864: item(1864, 3) } };
    assert(Warehouse.beginCraftReturn(changedBag, 1800000000002), 'new loot can wake the same warehouse stock');
    const atStation = { ...state, inventory: { ...state.inventory, 1864: item(1864, 6), 1869: item(1869, 9) } };
    assert(!Disposition.warehouseCandidates(atStation).some(row => [1864, 1869].includes(row.selfId)),
        'a released craft stage is not deposited again');

    rows = [[1890, 3, 0], [1459, 4, 0]];
    const final = Policy.stage({ ...state, inventory: { 4113: item(4113, 2) } }, Object.values(Index.inventory(state)));
    assert.equal(final?.recipeId, root.recipeId, 'finished intermediate materials unlock the final recipe');
    assert.deepEqual(final.requests, [{ selfId: 1890, amount: 3, reason: 'craft' },
        { selfId: 1459, amount: 4, reason: 'craft' }]);
    const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
    const field = { loc: { locX: 85000, locY: 150000, locZ: -3400 }, regionName: 'Giran' };
    const continuing = Craft.waitForWarehouseStage({ ...state, inventory: { 4113: item(4113, 2) } }, field, 1800000000000);
    assert.equal(continuing?.activity, 'shopping', 'a ready next stage stays in town after component crafting');
    assert.deepEqual(continuing.stats.marketReturn, field, 'the original field return survives the warehouse continuation');
    const missingKeys = { ...state, inventory: { 4113: item(4113, 1) } };
    assert.equal(Policy.stage(missingKeys, Object.values(Index.inventory(state))), null,
        'resources cannot start a stage before the key pieces');
    rows = [[4113, 1, 0], [1864, 1, 0]];
    const keys = Policy.stage(missingKeys, Object.values(Index.inventory(state)));
    assert.deepEqual(keys?.requests, [{ selfId: 4113, amount: 1, reason: 'craft' }],
        'a completed key set is withdrawn before the resource stage');
    const premature = { ...state, inventory: { 4113: item(4113, 1), 1864: item(1864, 6), 1869: item(1869, 9) } };
    assert.equal(invoke('GameServer/Bot/Economy/ColdCraftingService').readyRecipeFor(premature, root), null,
        'the station executor also waits for key pieces before crafting a ready intermediate');
    if (process.argv.includes('--benchmark')) {
        rows = [[1864, 4, 0], [1869, 7, 0]];
        const stored = Object.values(Index.inventory(state)), samples = [];
        for (let i = 0; i < 300; i++) {
            const start = process.hrtime.bigint(); Policy.stage(state, stored);
            samples.push(Number(process.hrtime.bigint() - start) / 1e6);
        }
        samples.sort((a, b) => a - b);
        console.log(`Warehouse stage p50=${samples[149].toFixed(3)} ms p95=${samples[284].toFixed(3)} ms (300 local checks)`);
        rows = [[1864, 3, 0], [1869, 7, 0]];
        const cached = [];
        for (let i = 0; i < 300; i++) {
            const start = process.hrtime.bigint(); Warehouse.beginCraftReturn(state, 1800000010000);
            cached.push(Number(process.hrtime.bigint() - start) / 1e6);
        }
        cached.sort((a, b) => a - b);
        console.log(`Warehouse unchanged review p50=${cached[149].toFixed(3)} ms p95=${cached[284].toFixed(3)} ms (300 local checks)`);
    }
    console.log('Active personal warehouse: accumulation, stage release, no loop and final recipe passed');
} finally {
    Index.useRowSource(); Recipes.resolveByRecipeId = originalId; Recipes.resolveByProductId = originalProduct;
    Shops.publishedStationRecipes = originalStations;
}
