'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('crystal-surplus-market');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Supplies = invoke('GameServer/Clan/ClanSupplyPolicy');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Native = require('./helpers/nativeMarketFixture');
const sellerId = 938002, buyerId = 938001;
const point = { locX: 83396, locY: 147904, locZ: -3400 };
const saleOptions = { unlimited: true, keptAmounts: {} };
const inventory = (id, amount = 20) => ({ [id]: { selfId: id, amount, kind: 'Other.None', stackable: true } });
const state = (id = 1458, stats = {}) => ({ characterId: sellerId, accountName: 'bot_crystal_seller',
    phase: 'cold', activity: 'shopping', currentRegion: 'Giran', level: 40,
    inventory: inventory(id), stats: { classId: 0, ...stats }, timing: {}, loc: point });
const exchange = { strategy: 'luxury_exchange', status: 'active', target: { selfId: 95 },
    materials: [{ selfId: 1458, amount: 12 }] };
const count = (s, extra = {}) => Disposition.saleCandidates(s, { ...saleOptions, ...extra })
    .find(row => row.selfId === 1458)?.count || 0;
const adopt = result => Object.values(result.coldLifeRows || {}).forEach(row => Life.acceptLifecycleRow(row));

async function run() {
    Data.init(); Database.init();
    const quoteOptions = { ...saleOptions, now: 1800000000000, board: new BoardIndex(),
        npcOffersFor: () => [], findSpot: () => null };
    for (const id of [1458, 1459, 1460, 1461, 1462]) {
        const bot = state(id), before = structuredClone(bot);
        const candidate = Disposition.saleCandidates(bot, saleOptions).find(row => row.selfId === id);
        assert.equal(candidate?.count, 20, `free grade crystal ${id} reaches sale selection`);
        assert.equal(Listing.classify(bot, candidate).action, 'market');
        assert.equal(Disposition.isSpareConsumable(bot.inventory[id]), false, 'crystals remain crafting inputs');
        assert.equal(Disposition.npcLiquidationCandidates(bot).length, 0, 'cleanup cannot quote grade crystals to the NPC');
        assert.equal(Providers.liquidationCandidates(bot, { stock: () => ({ itemId: 1464, target: 0 }) }).length,
            0, 'the planner cannot count crystals as immediate NPC funding');
        const sale = Listing.evaluate(bot, quoteOptions);
        assert.equal(sale.npc.length, 0, 'a crystal with no known buyer is not NPC junk');
        assert.equal(sale.listings[0]?.count, 20, 'free crystals publish a waiting market quote');
        assert(sale.listings[0].price > 0);
        assert.equal(sale.decisions[0].priced.ask.stockQuote, true);
        assert(Number.isNaN(sale.decisions[0].priced.ask.money), 'a waiting quote promises no receipts');
        const full = Listing.evaluate(bot, { ...quoteOptions, slots: 0 });
        assert.equal(full.npc.length, 0, 'a full board cannot send crystals to the NPC');
        assert.equal(full.decisions[0].action, 'keep', 'displaced crystals wait in the bag');
        const knownDemand = Listing.evaluate(bot, { ...quoteOptions,
            demandFor: () => ({ known: true, applicableUnits: 0, delayHours: 0 }) });
        assert.equal(knownDemand.listings[0]?.count, 20,
            'even known exhausted demand leaves a quote instead of an NPC fallback');
        const line = { ownerId: sellerId, recordId: id, lineId: id, selfId: id, storeType: 1,
            custodyPolicy: 0, count: 20, price: 1, town: 'Giran', revision: 1,
            pricing: Pricing.lineState(id, Listing.traderContext(bot, quoteOptions), { price: 1 }) };
        const review = Pricing.look(bot, [line], { ...Listing.traderContext(bot, { ...quoteOptions,
            demandFor: () => ({ known: true, applicableUnits: 0, delayHours: 0 }) }),
            reviewReasons: new Map([[line.lineId, 2]]) });
        assert.equal(review?.withdrawals.length || 0, 0, 'an NPC price comparison cannot withdraw existing crystal supply');
        assert(review?.reprices[0]?.price > 1, 'the existing backed offer actually receives its market quote');
        assert.deepEqual(bot, before, 'sale selection does not consume physical stock');
    }
    assert.equal(count(state(1458, { equipmentPlan: exchange })), 8, 'C luxury inputs stay reserved');
    assert.equal(count(state(1458, { equipmentPlan: { ...exchange, materials: [{ selfId: 1458, amount: 25 }] } })),
        0, 'an incomplete exchange cannot sell its collected crystals');
    assert.equal(count(state(1458, { equipmentPlan: { strategy: 'craft', status: 'active',
        materials: [{ selfId: 1458, amount: 6 }] } })), 14, 'equipment craft inputs stay reserved');
    const paused = { ...exchange, status: 'deferred', strategy: 'none', reason: 'wish_focus',
        target: { selfId: 76, slot: 7 }, exchange: { kind: 'luxury_exchange' } };
    assert.equal(count(state(1458, { equipmentPlan: paused, wishFocus: ['stock:scrolls', 0, 100] })), 8,
        'a temporary scroll restock preserves the unfinished personal exchange reserve');
    assert.equal(count(state(1458, { equipmentPlan: { ...paused, materials: [{ selfId: 1458, amount: 25 }] } })), 0,
        'all collected crystals remain reserved while a deferred exchange is incomplete');
    assert.equal(count(state(1458, { equipmentPlan: { ...paused, reason: 'cancelled' } })), 20,
        'a cancelled plan releases its inputs');
    assert.equal(count(state(1458, { equipmentPlan: { ...paused, target: { selfId: 80, slot: 7 } } })), 20,
        'a deferred higher-grade target blocked by the C milestone releases its old reservation');
    const resumedCraft = { strategy: 'none', status: 'deferred', reason: 'wish_focus', recipeId: 1,
        target: { selfId: 76, slot: 7 }, materials: [{ selfId: 1458, amount: 6 }] };
    assert.equal(count(state(1458, { equipmentPlan: resumedCraft })), 14, 'deferred personal craft retains its collected inputs');
    const incompleteCraft = { ...resumedCraft, status: 'active', strategy: 'craft',
        materials: [{ selfId: 1458, amount: 353 }] };
    const pausedCraft = Selection.deferredWishPlan(incompleteCraft, {}, state());
    assert.equal(pausedCraft.heldInputs[1458], 20, 'deferral captures the already collected inputs');
    const marketPlan = Selection.withMarketCraftPreparation(state(), incompleteCraft,
        { strategy: 'market', status: 'active', target: incompleteCraft.target });
    assert.equal(marketPlan.inputPreparation.heldInputs[1458], 20, 'a tentative finished-item purchase keeps collected ingredients');
    assert.equal(count(state(1458, { equipmentPlan: marketPlan })), 0,
        'a failed or pending purchase cannot expose those ingredients for sale');
    const recheckedMarket = Selection.withMarketCraftPreparation(state(), marketPlan,
        { strategy: 'market', status: 'active', target: incompleteCraft.target });
    assert.equal(recheckedMarket.inputPreparation.heldInputs[1458], 20, 'a market review retains the same prepared inputs');
    const olderCraft = { ...pausedCraft, target: { selfId: 129, slot: 7 }, heldInputs: { 1458: 10 } };
    const currentCraft = { ...incompleteCraft, inputPreparation: olderCraft };
    const doubleState = state(1458, { equipmentPlan: currentCraft });
    const selector = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const originalConsiderable = selector.considerable;
    selector.considerable = () => true;
    try {
        const pending = Selection.withMarketCraftPreparation(doubleState, currentCraft,
            { strategy: 'market', status: 'active', target: currentCraft.target });
        assert.equal(pending.inputPreparation.heldInputs[1458], 10, 'the current project captures only its unreserved share');
        assert.equal(pending.inputPreparation.inputPreparation.heldInputs[1458], 10, 'the older project retains its share');
        assert.equal(Disposition.retainedEquipmentAmounts({ ...doubleState, stats: { ...doubleState.stats, equipmentPlan: pending } })[1458], 20,
            'both retained projects protect their captured inputs');
        const resumedOlder = Selection.withRetainedCraftPreparation(doubleState, currentCraft,
            { strategy: 'craft', status: 'active', target: olderCraft.target, recipeId: olderCraft.recipeId });
        assert.equal(resumedOlder.inputPreparation.target.selfId, currentCraft.target.selfId,
            'switching back retains the project just paused');
        assert(!resumedOlder.inputPreparation.inputPreparation,
            'the resumed project is removed from the retained chain and cannot reserve its inputs twice');
    } finally { selector.considerable = originalConsiderable; }
    const switched = Selection.withRetainedCraftPreparation(state(), incompleteCraft,
        { strategy: 'direct_drop', status: 'active', target: { selfId: 129, slot: 7 } });
    assert.equal(switched.inputPreparation.heldInputs[1458], 20, 'a different equipment objective retains the prepared craft');
    assert.equal(count(state(1458, { equipmentPlan: switched })), 0, 'switching targets cannot sell its ingredients');
    const unsourced = Selection.withRetainedCraftPreparation(state(), { ...incompleteCraft, status: 'blocked', next: null },
        { strategy: 'direct_drop', status: 'active', target: { selfId: 129, slot: 7 } });
    assert(unsourced.inputPreparation, 'an unfarmable craft remains a purchase project behind a different objective');
    assert(Selection.withRetainedCraftPreparation(state(), incompleteCraft,
        { strategy: 'craft', status: 'ready_to_craft', target: { selfId: 129, slot: 7 } }).inputPreparation,
    'a ready temporary craft cannot discard the earlier project');
    const productionStock = state(1458, { equipmentPlan: pausedCraft });
    productionStock.inventory[1458].amount += 11;
    assert.equal(count(productionStock), 11, 'new production inputs stay free of the paused gear reserve');
    assert.equal(invoke('GameServer/Bot/Economy/ShotCraftPolicy').availableMaterial(productionStock, 1458), 11);
    const productionIterator = invoke('GameServer/Bot/Population/ColdOccupationSources').reservations(productionStock);
    let productionStep; do { productionStep = productionIterator.next(); } while (!productionStep.done);
    assert.equal(productionStep.value[1458], 20, 'the worker and executor protect the same fixed quantity');
    assert.deepEqual(Selection.deferredWishPlan(pausedCraft, {}, productionStock).heldInputs, pausedCraft.heldInputs,
        'repeated reviews cannot absorb new purchases into the old reserve');
    const resumed = { ...pausedCraft, status: 'active', strategy: 'craft' };
    assert.equal(count(state(1458, { equipmentPlan: resumed })), 0, 'resuming gear collection restores its full requirement');
    assert.equal(Selection.deferredWishPlan(resumed, {}, productionStock).heldInputs[1458], 31,
        'a later pause captures the newly collected gear inputs');
    const productionTrip = { ...productionStock, stats: { ...productionStock.stats,
        shotCraft: { preparing: { recipeId: 20, batches: 11, gearTarget: 76,
            gearInputs: { 1458: 20 }, at: Date.now() } } } };
    const replanned = Selection.deferredWishPlan({ ...incompleteCraft }, {}, productionTrip);
    assert.equal(replanned.heldInputs[1458], 20,
        'an intervening gear replan cannot claim the production inputs bought during its trip');
    assert.equal(count(productionTrip), 0, 'the selected production lot cannot return to the market before crafting');
    assert.equal(Disposition.warehouseCandidates(productionTrip).some(row => row.selfId === 1458), false,
        'storage cannot take the selected production input');
    assert.equal(invoke('GameServer/Bot/Economy/ShotCraftPolicy').availableMaterial(productionTrip, 1458), 11,
        'the production executor can consume its own retained inputs');
    const expiredProduction = { ...productionTrip, stats: { ...productionTrip.stats,
        shotCraft: { preparing: { ...productionTrip.stats.shotCraft.preparing, at: Date.now() - 31 * 60000 } } } };
    assert.equal(count(expiredProduction), 11, 'an obsolete production setup releases only its own input reserve');
    assert.notEqual(Disposition.reservationInputKey(productionStock),
        Disposition.reservationInputKey({ ...productionStock, stats: { equipmentPlan: { ...pausedCraft, heldInputs: { 1458: 21 } } } }),
        'reservation caches include the paused physical ownership');
    const bridge = Selection.withBridgeInputPreparation(state(), paused,
        { strategy: 'npc', status: 'active', weaponBridge: true, target: { selfId: 129, slot: 7 } });
    assert(bridge.inputPreparation, 'a D weapon bridge keeps the unfinished C input goal');
    assert.equal(Selection.withBridgeInputPreparation(state(), { ...paused, reason: 'cancelled' },
        { ...bridge, inputPreparation: undefined }).inputPreparation, undefined,
        'a bridge does not revive a cancelled C goal');
    const bridgeState = state(1458, { equipmentPlan: bridge });
    assert.equal(count(bridgeState), 8, 'the executable D goal cannot sell C inputs');
    const bridgeIterator = invoke('GameServer/Bot/Population/ColdOccupationSources').reservations(bridgeState);
    let bridgeStep; do { bridgeStep = bridgeIterator.next(); } while (!bridgeStep.done);
    assert.equal(bridgeStep.value[1458], 12, 'worker reservations keep C inputs across the bridge');
    assert.equal(count(state(1458, { equipmentPlan: { ...bridge, reason: 'cancelled' } })), 20);
    assert.equal(count(state(1458, { classId: 37, equipmentPlan: bridge })), 20,
        'a class change releases an incompatible retained target');
    const fulfilledBridge = state(1458, { equipmentPlan: bridge });
    fulfilledBridge.inventory[76] = { selfId: 76, amount: 1, equipped: true, equippedSlots: [7], slot: 7 };
    assert.equal(count(fulfilledBridge), 20, 'a fulfilled C target releases retained inputs');
    assert.notEqual(Disposition.reservationInputKey(bridgeState),
        Disposition.reservationInputKey(state(1458, { equipmentPlan: { ...bridge, inputPreparation: undefined } })),
        'reservation caches distinguish the retained C goal');
    const sourceIterator = invoke('GameServer/Bot/Population/ColdOccupationSources').reservations(
        state(1458, { equipmentPlan: paused }));
    let sourceStep; do { sourceStep = sourceIterator.next(); } while (!sourceStep.done);
    assert.equal(sourceStep.value[1458], 12, 'worker stock feasibility uses the same deferred exchange reserve');
    assert.equal(Disposition.reservationInputKey(state(1458, { equipmentPlan: paused })),
        Disposition.reservationInputKey(state(1458, { equipmentPlan: { ...paused, strategy: 'luxury_exchange', status: 'active' } })),
        'temporary activity changes do not invalidate the physical input reservation');
    assert.equal(count(state(), { reserved: { 1458: 7 } }), 13, 'selected production inputs stay reserved');
    const stock = state(); stock.inventory[1458].reservedAmount = 9;
    assert.equal(count(stock), 11, 'explicit physical reservations stay owned');
    stock.inventory[1458].acceptedCustomer = true;
    assert.equal(count(stock), 0, 'accepted customer stock cannot be sold');
    const selected = { kind: 'luxury_exchange', grossRequirements: [{ key: 'item:1458', amount: 12 }],
        requirements: [{ key: 'item:1458', amount: 12 }] };
    const network = { activity: { rootKey: 'power:95:14' },
        queue: [{ key: 'power:95:14', plan: { requirements: [{ key: 'item:95', plan: selected }] } }] };
    const selectedReserve = Disposition.selectedCraftAmounts(state(), network);
    assert.equal(selectedReserve[1458], 12, 'selected wish DAG protects the physical luxury input');
    assert.equal(count(state(), { reserved: selectedReserve }), 8);
    Supplies.useRowSource(id => id === 42 ? [42, 1, [[1458, 3]], 1] : undefined);
    assert.equal(count(state(1458, { clanId: 42, equipmentPlan: exchange })), 5,
        'personal C exchange and active clan need have separate quantities');
    Supplies.useRowSource();

    for (const [id, name] of [[sellerId, 'CrystalSeller'], [buyerId, 'CrystalBuyer']]) {
        await Native.character(Database, id, name, `bot_crystal_${id}`, point);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000, stackable: true });
    }
    await Database.setItem(sellerId, { selfId: 1458, name: 'Crystal: D-Grade', amount: 20, stackable: true });
    for (const id of [sellerId, buyerId]) await Life.upsertState({ ...state(), characterId: id,
        accountName: `bot_crystal_${id}`, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId: 0, money: [1000, 0, 0, 0], ...(id === sellerId ? { equipmentPlan: bridge } : {}) },
        vitals: { hp: 100, maxHp: 100 } }, 'fixture');
    const held = Life.snapshot(sellerId);
    assert.equal(await Life.applyNpcLiquidation(held, [{ selfId: 1458, count: 20, npcPrice: 1000 }]), held,
        'a stale NPC decision cannot sell crystals or mint its payout');
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 1458), 20);
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 57), 10000);
    const producing = await Life.upsertState({ ...held, stats: { ...held.stats,
        shotCraft: { preparing: { recipeId: 20, batches: 5, at: Date.now() } } } }, 'fixture_production_inputs');
    const crystalItem = (await Database.fetchItems(sellerId)).find(row => row.selfId === 1458);
    await assert.rejects(invoke('GameServer/AfkTrade/AfkTradeService').publishBot(sellerId,
        { kind: 'shop', storeType: 1, town: 'Giran', title: 'Stale surplus', ...point,
            lines: [{ selfId: 1458, objectId: crystalItem.id, count: 8, price: 10, stackable: true }] }),
    /economy_material_protected/, 'the native publication refuses a stale proposal that would escrow production materials');
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 1458), 20);
    await Life.upsertState({ ...Life.snapshot(sellerId), stats: { ...producing.stats, shotCraft: null } }, 'fixture_production_finished');
    async function accept(amount, token, purpose = { key: 'resale:1458', recipeId: 0 }) {
        const old = (await Database.fetchAfkTradeShops(buyerId)).filter(row => row.kind === 'buy_ad');
        await Database.replaceBoardRecords(buyerId, 'buy_ad', [{ storeType: 3, town: 'Giran',
            lines: [{ selfId: 1458, name: 'Crystal: D-Grade', count: amount, price: 10, stackable: true,
                intent: { itemId: 1458, amount, price: 10, ...purpose,
                    valueHours: 2, valueRate: 100 } }] }],
        { expected: Object.fromEntries(old.map(row => [row.id, row.revision])) });
        const ad = (await Database.fetchAfkTradeShops(buyerId)).find(row => row.kind === 'buy_ad');
        const parties = await Promise.all([buyerId, sellerId].map(id => Database.prepareTradeParticipant(id)));
        const source = parties[1].inventory.find(row => row.selfId === 1458);
        return Database.acceptTradeMeeting({ token, actorA: buyerId, actorB: sellerId,
            seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Giran', point,
            lines: [{ payer: 0, itemId: source.id, selfId: 1458, enchant: 0, count: amount, price: 10,
                needAdId: ad.id, needAdRevision: ad.revision, certificate: JSON.parse(ad.lines[0].intentJson) }],
            parties: parties.map(p => ({ ...p, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })) });
    }
    await assert.rejects(accept(9, 'crystal-reserve-overdraw'), /economy_material_protected/,
        'atomic acceptance cannot reserve crystals needed by C exchange');
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 1458), 20, 'refused sale preserves stock');
    const accepted = await accept(8, 'crystal-surplus-sale'); adopt(accepted);
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 1458), 12, 'only surplus enters meeting custody');
    const completed = await Database.arriveTradeMeeting(accepted.meeting.id); adopt(completed);
    assert.equal(completed.meeting.state, 'completed');
    for (const id of [sellerId, buyerId]) await Database.settleBoardOwner(id);
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 1458), 12, 'C reserve survives final delivery');
    assert.equal(Native.amount(await Database.fetchItems(buyerId), 1458), 8, 'buyer receives the physical surplus');
    assert.equal(Native.amount(await Database.fetchItems(sellerId), 57), 10080);
    assert.equal(Native.amount(await Database.fetchItems(buyerId), 57), 9920);
    const selling = await Life.syncExternalInventory(buyerId, 'fixture_settlement');
    const sale = Listing.evaluate(selling, quoteOptions);
    assert.equal(sale.listings[0]?.count, 8, 'the received free crystals can be offered again');
    const published = await invoke('GameServer/Bot/Economy/BotAfkMarketService').listOnBoard(selling,
        { decided: sale, now: quoteOptions.now });
    assert(published.listed > 0, 'the native board publishes the actual crystal stock');
    const records = await Database.fetchAfkTradeShops(buyerId);
    const offers = records.filter(row => row.storeType === 1 && row.status === 'active')
        .flatMap(row => row.lines).filter(row => row.selfId === 1458);
    assert.equal(offers.reduce((sum, row) => sum + row.count, 0), 8);
    assert.equal(Native.amount(await Database.fetchItems(buyerId), 57), 9920,
        'publishing a crystal quote creates no adena');
    // A delayed craft purchase must record the reserve in the same physical
    // meeting transaction, including across the cold lifecycle snapshot.
    const buyer = Life.cachedState(buyerId);
    await Life.upsertState({ ...buyer, stats: { ...buyer.stats, equipmentPlan: {
        strategy: 'direct_drop', status: 'active', target: { selfId: 129, slot: 7 },
        inputPreparation: { status: 'deferred', strategy: 'none', reason: 'wish_focus', recipeId: 192,
            target: { selfId: 90, slot: 7 }, heldInputs: { 1458: 4 },
            inputPreparation: { ...pausedCraft, heldInputs: { 1458: 1 } } }
    } } }, 'fixture_retained_purchase');
    await Database.setItem(sellerId, { selfId: 1458, name: 'Crystal: D-Grade', amount: 2, stackable: true });
    await Life.syncExternalInventory(sellerId, 'fixture_new_surplus');
    const retainedMeeting = await accept(2, 'retained-craft-purchase', { key: 'power:76:7', recipeId: 1 });
    adopt(retainedMeeting);
    adopt(await Database.arriveTradeMeeting(retainedMeeting.meeting.id));
    const receipt = (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [buyerId]]))[0];
    assert.equal(JSON.parse(receipt.statsJson).equipmentPlan.inputPreparation.inputPreparation.heldInputs[1458], 3,
        'the retained kit owns the two received units immediately and durably');
    assert.equal(JSON.parse(receipt.statsJson).equipmentPlan.inputPreparation.heldInputs[1458], 4,
        'the newer project does not claim the older project’s purchase');
    console.log('Crystal surplus: market-only sales, full board, review, reservations, native publication and settlement passed');
}
run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
