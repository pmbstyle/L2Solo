const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

DataCache.init();

const marketItem = DataCache.items.find((item) => (
    item?.etc?.rank === 'c' && item.template?.kind?.startsWith('Weapon.') && Number(item.template?.price || 0) > 1000
));
const spellbook = DataCache.items.find((item) => /spellbook/i.test(item?.template?.name || ''));
const equippedItem = DataCache.items.find((item) => (
    item !== marketItem && item?.etc?.rank === 'c' && Number(item.etc?.slot || 0) === Number(marketItem?.etc?.slot || 0)
));
const speculativeItem = DataCache.items.find((item) => (
    item !== marketItem
    && item !== equippedItem
    && (item?.template?.kind?.startsWith('Weapon.') || item?.template?.kind?.startsWith('Armor.'))
    && ItemDisposition.gradeIndex(item?.etc?.rank) >= ItemDisposition.gradeIndex('c')
    && Number(item.template?.price || 0) >= 10000
    && !invoke('GameServer/Bot/Economy/MarketListingPolicy').starterItemIds().has(Number(item.selfId))
));
assert(marketItem && equippedItem && speculativeItem && spellbook, 'the datapack must contain market gear and spellbook fixtures');

const originals = {
    execute: Database.execute,
    fetchItems: Database.fetchItems,
    fetchWarehouseItems: Database.fetchWarehouseItems,
    updateItemAmount: Database.updateItemAmount,
    updateItemEquipState: Database.updateItemEquipState,
    updateCharacterLocation: Database.updateCharacterLocation,
    updateCharacterExperience: Database.updateCharacterExperience,
    updateCharacterVitals: Database.updateCharacterVitals,
    syncInventorySummary: Database.syncInventorySummary,
    transferInventoryToWarehouse: Database.transferInventoryToWarehouse,
    allStates: LifeState.allStates
};
const calls = [];

async function run() {
    Database.execute = () => Promise.resolve([]);
    Database.fetchItems = () => Promise.resolve([
        { id: 20, selfId: 57, amount: 500, equipped: false, slot: 0 },
        { id: 21, selfId: marketItem.selfId, amount: 1, equipped: false, slot: marketItem.etc.slot },
        { id: 22, selfId: equippedItem.selfId, amount: 1, equipped: true, slot: equippedItem.etc.slot }
    ]);
    Database.fetchWarehouseItems = () => Promise.resolve([]);
    Database.updateItemAmount = (characterId, id, amount) => {
        calls.push({ type: 'amount', characterId, id, amount });
        return Promise.resolve();
    };
    Database.updateItemEquipState = () => Promise.resolve();
    Database.updateCharacterLocation = () => Promise.resolve();
    Database.updateCharacterExperience = () => Promise.resolve();
    Database.updateCharacterVitals = () => Promise.resolve();
    Database.transferInventoryToWarehouse = () => Promise.resolve({ inventoryAmount: 0 });
    Database.syncInventorySummary = (characterId, inventory) => {
        calls.push({ type: 'inventory-sync', characterId, inventory });
        return Promise.resolve();
    };

    const state = {
        characterId: 88,
        accountName: 'seller88',
        name: 'ColdSeller',
        level: 10,
        adena: 500,
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Giran',
        spotId: 'starter_local',
        loc: { locX: 82698, locY: 148638, locZ: -3473 },
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: {},
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 500 },
            [marketItem.selfId]: { selfId: marketItem.selfId, name: marketItem.template.name, amount: 1, equipped: false, slot: marketItem.etc.slot, kind: marketItem.template.kind, rank: 'c' },
            [equippedItem.selfId]: { selfId: equippedItem.selfId, name: equippedItem.template.name, amount: 1, equipped: true, slot: equippedItem.etc.slot, kind: equippedItem.template.kind, rank: 'c' }
        },
        stats: {
            equipment: [{ selfId: equippedItem.selfId, slot: equippedItem.etc.slot }],
            marketReturn: { loc: { locX: 1, locY: 2, locZ: 3 }, regionName: 'Dion', spotId: 'starter_local' }
        }
    };

    const candidates = ItemDisposition.saleCandidates(state);
    assert.deepStrictEqual(candidates.map((item) => item.selfId), [marketItem.selfId], 'equipped gear must never be listed');
    const malformedEquippedCount = ItemDisposition.saleCandidates({
        ...state,
        inventory: {
            57: state.inventory[57],
            [marketItem.selfId]: { ...state.inventory[marketItem.selfId], amount: 2, equippedCount: 'broken' }
        }
    });
    assert.strictEqual(malformedEquippedCount[0].count, 2,
        'invalid persisted equipped counts must not produce NaN sale quantities');

    const preTradeState = {
        ...state,
        level: 9,
        stats: { ...state.stats, generatedCold: true }
    };
    assert.deepStrictEqual(ItemDisposition.saleCandidates(preTradeState), [], 'generated bots must not sell before level ten');
    const preTradeListing = await ListingService.open(preTradeState, { now: 1000 });
    assert.strictEqual(preTradeListing.reason, 'nothing_to_sell', 'pre-ten generated bots must never open a private store');
    assert.strictEqual(
        preTradeListing.state.stats.marketSellRetryAfter,
        1000 + ListingService.SELL_RETRY_DELAY_MS,
        'a market visit with nothing sellable must not immediately repeat'
    );

    const preTradeCleanup = {
        ...preTradeState,
        characterId: 95,
        name: 'PreTradeCleanupSeller',
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 500 },
            [spellbook.selfId]: {
                selfId: spellbook.selfId,
                name: spellbook.template.name,
                amount: 1,
                equipped: false,
                kind: spellbook.template.kind,
                stackable: false
            }
        },
        stats: {
            ...preTradeState.stats,
            forcedMarketCleanup: {
                cleanupReason: 'npc_only_inventory',
                itemCount: 1,
                npcOnlySlots: 1
            }
        }
    };
    const preTradeCleanupResult = await ListingService.open(preTradeCleanup, {
        now: 1000,
        forcedCleanup: preTradeCleanup.stats.forcedMarketCleanup
    });
    assert.strictEqual(preTradeCleanupResult.listed, false, 'pre-trade cleanup must never open a private store');
    assert.strictEqual(preTradeCleanupResult.reason, 'pre_trade_npc_cleanup');
    assert.strictEqual(preTradeCleanupResult.state.stats.lastNpcLiquidation.source, 'pre_trade_npc_cleanup');
    assert.strictEqual(preTradeCleanupResult.state.stats.forcedMarketCleanup, null, 'pre-trade cleanup must consume forced intent');

    const starterMobLootState = {
        ...state,
        stats: { ...state.stats, generatedCold: true },
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 500 },
            1: { selfId: 1, name: 'Short Sword', amount: 1, equipped: false, slot: 7, kind: 'Weapon.Sword', starterMobLootAmount: 1 },
            1864: { selfId: 1864, name: 'Stem', amount: 4, kind: 'Other.Material', starterMobLootAmount: 4 }
        }
    };
    const starterMobLootCandidates = ItemDisposition.saleCandidates(starterMobLootState);
    assert.deepStrictEqual(
        starterMobLootCandidates.map((item) => item.selfId),
        [1, 1864],
        'low-grade starter gear and materials must remain eligible for cleanup after level ten'
    );
    assert.strictEqual(
        MarketListingPolicy.classify(starterMobLootState, starterMobLootCandidates.find((item) => item.selfId === 1)).action,
        'npc',
        'low-grade starter gear must be routed to the NPC shop rather than retained or warehoused'
    );
    assert.deepStrictEqual(
        ItemDisposition.npcLiquidationCandidates(starterMobLootState).map((item) => item.selfId).sort((a, b) => a - b),
        [1, 1864],
        'the actual NPC liquidation path must include low-grade gear and cheap materials'
    );

    const marketBuyer = {
        characterId: 99,
        name: 'MarketBuyer',
        adena: 100000000,
        currentRegion: 'Giran',
        stats: { equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: marketItem.selfId, name: marketItem.template.name } } }
    };
    const listingOptions = { now: 1000, durationMs: 60000, random: () => 0.1, states: [marketBuyer] };
    const opened = await ListingService.open(state, listingOptions);
    assert.strictEqual(opened.listed, true);
    assert.strictEqual(opened.state.activity, 'merchant');
    assert.strictEqual(opened.state.stats.marketStore.title, marketItem.template.name.slice(0, 28), 'a dynamic store title should name its actual stock');
    assert(opened.state.stats.marketStore.title.length <= 28, 'a dynamic store title must fit the compact C4 store overlay');
    assert(ListingService.isGiranPlazaStallLocation(opened.state.loc), 'a Giran store must use the captured trading square and avoid its central column');
    assert.deepStrictEqual(opened.state.stats.marketStore.loc, opened.state.loc, 'the stall coordinate must survive hot/cold transitions');
    assert(Number(opened.state.stats.marketStore.nextReviewAt) > 1000, 'WTS must schedule demand revalidation before expiry');
    const secondStall = ListingService.chooseGiranPlazaStall(() => 0.1, [opened.state.loc]);
    const dx = secondStall.locX - opened.state.loc.locX;
    const dy = secondStall.locY - opened.state.loc.locY;
    assert(Math.sqrt(dx * dx + dy * dy) >= ListingService.GIRAN_STALL_MIN_DISTANCE, 'stores must not overlap on the Giran plaza');

    const partyOpened = await ListingService.open(
        { ...state, characterId: 94, name: 'PartySeller' },
        listingOptions
    );
    assert(MarketOpportunity.findOffers(marketItem.selfId, { town: 'Giran', now: 1001 })
        .some((entry) => Number(entry.sourceId) === 94), 'active party candidate store must start in market discovery');
    const partyWithdrawal = await ListingService.withdrawForParty(partyOpened.state, 2000);
    assert.strictEqual(partyWithdrawal.withdrawn, true);
    assert.strictEqual(partyWithdrawal.state.activity, 'hunting', 'party priority must end merchant activity before activation');
    assert.strictEqual(partyWithdrawal.state.stats.marketStore, null, 'party priority must remove the persisted private store');
    assert.strictEqual(partyWithdrawal.state.stats.marketReturn, null, 'completed market travel must not pull the companion away later');
    assert.deepStrictEqual(partyWithdrawal.state.loc, state.stats.marketReturn.loc, 'after party duty the bot should retain its pre-market hunting anchor');
    assert(!MarketOpportunity.findOffers(marketItem.selfId, { town: 'Giran', now: 2000 })
        .some((entry) => Number(entry.sourceId) === 94), 'withdrawn party store must disappear from market discovery immediately');

    const buyerRoutedState = {
        ...state,
        characterId: 87,
        name: 'BuyerRoutedSeller',
        currentRegion: 'Talking Island',
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 500 },
            1864: { selfId: 1864, name: 'Stem', amount: 10, kind: 'Other.Material' }
        }
    };
    const buyerRouted = await ListingService.open(buyerRoutedState, { now: 1000, durationMs: 60000 });
    assert.strictEqual(buyerRouted.listed, false, 'materials accepted by a static buyer must not create a dead private store');
    assert.strictEqual(buyerRouted.reason, 'sold_to_static_buyer');
    assert.strictEqual(buyerRouted.state.stats.lastNpcLiquidation.source, 'static_buyer');
    assert.strictEqual(
        buyerRouted.state.stats.marketSellRetryAfter,
        1000 + ListingService.SELL_RETRY_DELAY_MS,
        'a completed buyer sale without a private listing must defer the next market trip'
    );
    assert.strictEqual(GoalExecutor.beginMarketTravel({
        ...buyerRouted.state,
        activity: 'hunting'
    }, {
        type: 'sell_inventory',
        plan: { expectedBenefit: 'market_sale_inventory' }
    }, 1001), null, 'the deferred seller must resume hunting instead of starting another market loop');

    const remoteBuyerState = { ...buyerRoutedState, characterId: 86, currentRegion: 'Giran' };
    const remoteBuyer = await ListingService.open(remoteBuyerState, { now: 1000, durationMs: 60000 });
    assert.strictEqual(remoteBuyer.state.stats.lastNpcLiquidation?.source, undefined, 'a bot must not sell to a buyer in another town before travelling there');

    const ownOffer = MarketOpportunity.bestOffer(marketItem.selfId, { town: 'Giran', buyerCharacterId: 88, now: 1001 });
    assert(!ownOffer || ownOffer.sourceType !== 'cold_store', 'seller must not buy its own listing');
    const offer = MarketOpportunity.bestOffer(marketItem.selfId, { town: 'Giran', buyerCharacterId: 99, now: 1001 });
    assert.strictEqual(offer.sourceType, 'cold_store');
    assert.strictEqual(MarketOpportunity.reserve(offer), true);
    offer.buyerCharacterId = 99;

    const sold = await ListingService.settle(offer);
    assert.strictEqual(sold.adena, 500 + offer.price);
    assert.strictEqual(sold.inventory[String(marketItem.selfId)], undefined,
        'sold-out stock must not remain in the durable inventory summary');
    assert.strictEqual(sold.activity, 'shopping', 'selling the final item must close the store as part of the trade event');
    assert.strictEqual(sold.stats.marketStore, null);
    const soldSync = calls.find((call) => call.type === 'inventory-sync' && call.characterId === 88);
    assert.strictEqual(soldSync.inventory[String(marketItem.selfId)].amount, 0, 'the optimized sync must persist removal of sold stock');
    assert.strictEqual(soldSync.inventory['57'].amount, 500 + offer.price, 'the optimized sync must persist the adena payout');

    const phantom = {
        ...opened.state,
        inventory: { 57: { selfId: 57, name: 'Adena', amount: 500 } }
    };
    const reconciled = await ListingService.reconcileInventory(phantom);
    assert.strictEqual(reconciled.closed, true, 'a store without its listed inventory must close');
    assert.strictEqual(reconciled.state.activity, 'shopping');
    assert.strictEqual(reconciled.state.stats.marketStore, null);

    const expiredState = {
        ...state,
        characterId: 89,
        name: 'ExpiredSeller',
        simulation: { ownerId: 'legacy_main', revision: 12, leaseId: null, leaseUntil: 0 }
    };
    const expiredOpened = await ListingService.open(expiredState, listingOptions);
    const expiredResult = await ListingService.resolve(expiredOpened.state, 62000);
    assert.strictEqual(expiredResult.closed, true);
    assert.strictEqual(expiredResult.reason, 'expired');
    assert.strictEqual(expiredResult.state.activity, 'traveling',
        'an expired cold WTS must durably begin its return trip without an intermediate due shopping row');
    assert(Number(expiredResult.state.timing.nextResolveAt) > 62000);
    assert.strictEqual(expiredResult.state.simulation.revision, 12,
        'legacy market close writes must preserve the authoritative ownership revision in cache');
    const returnMessages = [];
    const returnKernel = new ColdSimulationKernel({
        resolveSolo: () => ({ patch: {}, materialize: { items: [] }, events: [], nextResolveAt: 120000 }),
        emit: (type, payload) => returnMessages.push({ type, payload }),
        now: () => Number(expiredResult.state.timing.nextResolveAt)
    });
    returnKernel.upsert({ state: expiredResult.state, context: {} });
    returnKernel.tick();
    assert.strictEqual(returnMessages[0]?.type, 'claim_request',
        'post-market return travel must re-enter dedicated worker scheduling when due');
    assert.strictEqual(returnMessages[0]?.payload.candidates[0]?.expectedRevision, 12,
        'post-market return travel must claim against the durable ownership revision');
    assert.strictEqual(expiredResult.state.inventory[String(marketItem.selfId)], undefined,
        'valuable unsold gear moved to the warehouse must leave the durable inventory summary');
    assert.strictEqual(expiredResult.state.adena, 500, 'warehouse storage must not mint Adena');
    assert.strictEqual(expiredResult.warehouseCount, 1);
    assert(Number(expiredResult.state.stats.marketSellRetryAfter) > 62000, 'valuable unsold stock needs a later market retry');

    const demandReviewOpened = await ListingService.open(
        { ...state, characterId: 91, name: 'DemandReviewSeller' },
        { ...listingOptions, durationMs: 300000 }
    );
    LifeState.allStates = () => [];
    const demandReview = await ListingService.resolve(demandReviewOpened.state, 122000);
    assert.strictEqual(demandReview.closed, true, 'an active WTS must close when its actionable demand disappears');
    assert.strictEqual(demandReview.reason, 'no_actionable_demand');
    LifeState.allStates = originals.allStates;

    const mixedState = {
        ...state,
        characterId: 92,
        name: 'MixedDemandSeller',
        inventory: {
            ...state.inventory,
            [speculativeItem.selfId]: {
                selfId: speculativeItem.selfId,
                name: speculativeItem.template.name,
                amount: 1,
                equipped: false,
                slot: speculativeItem.etc?.slot || 0,
                kind: speculativeItem.template.kind,
                rank: speculativeItem.etc?.rank || 'none'
            }
        }
    };
    const latentBuyer = {
        characterId: 100,
        name: 'LatentBuyer',
        adena: 100000000,
        currentRegion: 'Giran',
        stats: { equipmentPlan: { status: 'active', strategy: 'drop', target: { selfId: speculativeItem.selfId } } }
    };
    const mixedOpened = await ListingService.open(mixedState, {
        now: 1000,
        random: () => 0.1,
        states: [marketBuyer, latentBuyer]
    });
    const speculativeLine = mixedOpened.state.stats.marketStore.items.find((item) => Number(item.selfId) === Number(speculativeItem.selfId));
    assert.strictEqual(mixedOpened.state.stats.marketStore.expiresAt, 1000 + ListingService.DEFAULT_LISTING_MS);
    assert.strictEqual(speculativeLine.marketExpiresAt, 1000 + ListingService.SPECULATIVE_LISTING_MS, 'speculative lines need their own short TTL in a mixed store');
    LifeState.allStates = () => [marketBuyer, latentBuyer];
    const mixedReview = await ListingService.resolve(mixedOpened.state, 1001 + ListingService.SPECULATIVE_LISTING_MS);
    assert.strictEqual(mixedReview.closed, false, 'active-demand stock should keep the mixed store open');
    assert.deepStrictEqual(mixedReview.state.stats.marketStore.items.map((item) => Number(item.selfId)), [Number(marketItem.selfId)], 'expired speculative stock must be pruned independently');
    LifeState.allStates = originals.allStates;

    const hotOpened = await ListingService.open(
        { ...state, characterId: 93, name: 'HotDemandSeller' },
        { ...listingOptions, durationMs: 300000 }
    );
    let liveStore = { ...hotOpened.state.stats.marketStore, items: hotOpened.state.stats.marketStore.items.map((item) => ({ ...item })) };
    let privateStoreType = 1;
    const hotSession = {
        accountId: 'bot_hot_market',
        plan: 'merchant',
        coldMarketState: { ...hotOpened.state, phase: 'hot' },
        actor: {
            fetchPrivateStore: () => liveStore,
            setPrivateStore: (store) => { liveStore = store; },
            setPrivateStoreType: (value) => { privateStoreType = value; },
            state: { setSeated: () => {} }
        }
    };
    LifeState.allStates = () => [];
    const hotReview = await ListingService.resolveHotSession(hotSession, 122000);
    assert.strictEqual(hotReview.closed, true, 'a visible hot WTS must close when actionable demand disappears');
    assert.strictEqual(hotSession.coldMarketState.phase, 'hot', 'live maintenance must not dematerialize the actor behind the session');
    assert.strictEqual(hotSession.coldMarketState.stats.marketStore, null);
    assert.strictEqual(hotSession.plan, 'shopping');
    assert.strictEqual(privateStoreType, 0);
    assert.strictEqual(liveStore.items.length, 0, 'closed hot WTS stock must disappear from live offer discovery');
    LifeState.allStates = originals.allStates;

    const misplacedExpired = await ListingService.open(
        { ...state, characterId: 90, name: 'MisplacedExpiredSeller' },
        listingOptions
    );
    const misplacedExpiredResult = await ListingService.resolve({
        ...misplacedExpired.state,
        stats: { ...misplacedExpired.state.stats, marketStore: { ...misplacedExpired.state.stats.marketStore, town: 'Dion' } }
    }, 62000);
    assert.strictEqual(misplacedExpiredResult.closed, true, 'an expired store must close instead of being relocated to another market');

    assert.strictEqual(
        ListingService.marketStoreTitle([
            { name: 'Animal Bone', count: 20 },
            { name: 'Stem', count: 5 },
            { name: 'Very Long Weapon Name That Cannot Fit', count: 1 }
        ]),
        'Animal Bone x20, Stem x5 +1',
        'compact titles should identify stock and summarize omitted listings'
    );
    assert.strictEqual(ListingService.marketStoreTitle([{ name: 'Very Long Weapon Name That Cannot Fit', count: 1 }]).length, 28, 'a single long item name must be safely truncated');
    console.log('Bot cold market listing checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Database.execute = originals.execute;
    Database.fetchItems = originals.fetchItems;
    Database.fetchWarehouseItems = originals.fetchWarehouseItems;
    Database.updateItemAmount = originals.updateItemAmount;
    Database.updateItemEquipState = originals.updateItemEquipState;
    Database.updateCharacterLocation = originals.updateCharacterLocation;
    Database.updateCharacterExperience = originals.updateCharacterExperience;
    Database.updateCharacterVitals = originals.updateCharacterVitals;
    Database.syncInventorySummary = originals.syncInventorySummary;
    Database.transferInventoryToWarehouse = originals.transferInventoryToWarehouse;
    LifeState.allStates = originals.allStates;
    LifeState.reset?.();
    MarketOpportunity.resetColdStores();
});
