const assert = require('assert');

require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fixtureFs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fixtureFs.rmSync(fixture.directory, { recursive: true, force: true }));

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const originalReconcileClanGoals = Database.reconcileBotClanGoals;
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');

DataCache.init();

const marketItem = DataCache.items.find((item) => (
    item?.etc?.rank === 'c' && item.template?.kind?.startsWith('Weapon.') && Number(item.template?.price || 0) > 1000
));
const spellbook = DataCache.items.find((item) => item?.template?.kind === 'Other.Spellbook');
const equippedItem = DataCache.items.find((item) => (
    item !== marketItem && item?.etc?.rank === 'c' && Number(item.etc?.slot || 0) === Number(marketItem?.etc?.slot || 0)
));
assert(marketItem && equippedItem && spellbook, 'the datapack must contain market gear and spellbook fixtures');

const originals = {
    reconcileBotClanMembership: Database.reconcileBotClanMembership,
    execute: Database.execute,
    fetchItems: Database.fetchItems,
    fetchMarketBuyerActivity: Database.fetchMarketBuyerActivity,
    fetchWarehouseItems: Database.fetchWarehouseItems,
    updateItemAmount: Database.updateItemAmount,
    updateItemEquipState: Database.updateItemEquipState,
    updateCharacterLocation: Database.updateCharacterLocation,
    updateCharacterExperience: Database.updateCharacterExperience,
    updateCharacterVitals: Database.updateCharacterVitals,
    syncInventorySummary: Database.syncInventorySummary,
    transferInventoryToWarehouse: Database.transferInventoryToWarehouse,
    allStates: LifeState.allStates,
    upsertState: LifeState.upsertState
};
const calls = [];

async function run() {
    // ARCH-NOTE: native specialized saves cannot be intercepted by an execute spy.
    Database.init();
    const native = require('./helpers/nativeMarketFixture');
    for (const [id, name] of [[88, 'ColdSeller'], [95, 'PreTradeCleanupSeller'], [87, 'BuyerRoutedSeller'], [86, 'RemoteBuyerSeller']]) {
        await native.character(Database, id, name, 'seller' + id, { locX: 82698, locY: 148638, locZ: -3473 });
    }
    await Database.setItem(95, { selfId: 57, name: 'Adena', amount: 500 });
    await Database.setItem(95, { selfId: spellbook.selfId, name: spellbook.template.name, amount: 1 });
    Database.reconcileBotClanMembership = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.execute = () => Promise.resolve([]);
    Database.fetchItems = () => Promise.resolve([
        { id: 20, selfId: 57, amount: 500, equipped: false, slot: 0 },
        { id: 21, selfId: marketItem.selfId, amount: 1, equipped: false, slot: marketItem.etc.slot },
        { id: 22, selfId: equippedItem.selfId, amount: 1, equipped: true, slot: equippedItem.etc.slot }
    ]);
    Database.fetchMarketBuyerActivity = () => Promise.resolve([]);
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
    assert.deepStrictEqual(ItemDisposition.saleCandidates(preTradeState).map(item => item.selfId), [marketItem.selfId],
        'young generated bots enter the same sale evaluation');
    const preTradeListing = await ListingService.open({ ...preTradeState, inventory: { 57: state.inventory[57] } }, { now: 1000 });
    assert.strictEqual(preTradeListing.reason, 'nothing_to_sell', 'a young bot with no goods opens no store');
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
    // Use the real inventory writer for this physical pre-trade cleanup.
    const preTradePhysicalBefore = await originals.fetchItems(95);
    const preTradePrice = ItemDisposition.npcLiquidationCandidates(preTradeCleanup, { allowPreTradeCleanup: true })
        .find(item => item.selfId === spellbook.selfId).npcPrice;
    assert.strictEqual(native.amount(preTradePhysicalBefore, spellbook.selfId), 1);
    assert.strictEqual(native.amount(preTradePhysicalBefore, 57), 500);
    Database.syncInventorySummary = originals.syncInventorySummary;
    let preTradeCleanupResult;
    try {
        preTradeCleanupResult = await ListingService.open(preTradeCleanup, {
            now: 1000, forcedCleanup: preTradeCleanup.stats.forcedMarketCleanup
        });
    } finally {
        Database.syncInventorySummary = (characterId, inventory) => {
            calls.push({ type: 'inventory-sync', characterId, inventory }); return Promise.resolve();
        };
    }
    const preTradePhysicalAfter = await originals.fetchItems(95);
    assert.strictEqual(native.amount(preTradePhysicalAfter, spellbook.selfId), 0);
    assert.strictEqual(native.amount(preTradePhysicalAfter, 57), 500 + preTradePrice);
    console.log('Native pre-trade physical cleanup:', JSON.stringify({ before: { wallet: 500, book: 1 },
        after: { wallet: native.amount(preTradePhysicalAfter, 57), book: native.amount(preTradePhysicalAfter, spellbook.selfId) }, price: preTradePrice }));
    assert.strictEqual(preTradeCleanupResult.listed, false, 'pre-trade cleanup must never open a private store');
    assert.strictEqual(preTradeCleanupResult.reason, 'pre_trade_npc_cleanup');
    // ARCH-NOTE: FX-M5 lastNpcLiquidation is a capped numeric tuple, the result carries the path reason.
    assert.deepStrictEqual(preTradeCleanupResult.state.stats.lastNpcLiquidation.sold, [[spellbook.selfId, 1, preTradePrice]]);
    assert.strictEqual(preTradeCleanupResult.state.stats.lastNpcLiquidation.payout, preTradePrice);
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
    // No market for it (no deal, no buyer): its best outcome is the NPC now
    // (group E: one expected-value decision, one roll).
    assert.strictEqual(
        MarketListingPolicy.evaluate(starterMobLootState, { now: 1000, persona: null }).decisions
            .find((decision) => decision.item.selfId === 1).action,
        'npc',
        'low-grade gear nobody buys goes to the NPC shop rather than retained or warehoused'
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
    const cooldownState = { ...state, stats: { ...state.stats, marketSellRetryAfter: 500000 } };
    const cooldown = await ListingService.open(cooldownState, listingOptions);
    assert.strictEqual(cooldown.listed, false, 'an already-shopping bot must obey its retry pause at the store entry point');
    assert.strictEqual(cooldown.reason, 'sell_retry_cooldown');
    const cleanupDuringCooldown = await ListingService.open(cooldownState, {
        ...listingOptions, forcedCleanup: { reason: 'inventory_capacity' }
    });
    assert.strictEqual(cleanupDuringCooldown.listed, false, 'forced cleanup must not reopen a speculative WTS');
    assert.strictEqual(cleanupDuringCooldown.state.stats.marketSellRetryAfter, 500000, 'cleanup must preserve the trading pause');
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
    const staticPrice = invoke('GameServer/Bot/Economy/StaticBuyerService').candidatesFor(buyerRoutedState, 'Talking Island')[0].npcPrice;
    assert.deepStrictEqual(buyerRouted.state.stats.lastNpcLiquidation.sold, [[1864, 10, staticPrice]]);
    assert.strictEqual(buyerRouted.state.stats.lastNpcLiquidation.payout, 10 * staticPrice);
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
    assert.strictEqual(remoteBuyer.state.stats.lastNpcLiquidation, undefined, 'a bot must not sell to a buyer in another town before travelling there');

    const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const SpotService = invoke('GameServer/Bot/AI/SpotService');
    const previousFindSpot = SpotProfiles.findForState;
    const previousArrival = SpotService.arrivalPointForState;
    try {
        SpotProfiles.findForState = () => null;
        const stranded = { ...state, stats: { ...state.stats, marketReturn: null } };
        const recovery = GoalExecutor.finishMarketVisit(stranded, 62000, { recoverMissingReturn: true });
        assert.strictEqual(recovery.activity, 'resting', 'a missing return route must leave shopping and schedule a retry');
        assert.strictEqual(recovery.timing.nextResolveAt, 92000);
        SpotProfiles.findForState = () => ({ id: 'recovery', name: 'Recovery field' });
        SpotService.arrivalPointForState = () => ({ locX: 100, locY: 100, locZ: 0 });
        const routed = GoalExecutor.finishMarketVisit(stranded, 62000, { recoverMissingReturn: true });
        assert.strictEqual(routed.activity, 'traveling');
        assert.strictEqual(routed.stats.travel.spotId, 'recovery');
        const stalePartyReturn = { ...stranded, stats: {
            ...stranded.stats, partyMarketReturn: { partyId: 'dissolved-party' }
        } };
        const soloReturn = GoalExecutor.finishMarketVisit(stalePartyReturn, 62000, { recoverMissingReturn: true });
        assert.strictEqual(soloReturn.stats.travel.arrivalActivity, 'hunting',
            'a fallback route must not wait for a dissolved party');
        assert.strictEqual(soloReturn.stats.partyMarketReturn, null,
            'solo recovery must discard the obsolete party return token');
        SpotProfiles.findForState = () => null;
        const soloRest = GoalExecutor.finishMarketVisit(stalePartyReturn, 62000, { recoverMissingReturn: true });
        assert.strictEqual(soloRest.activity, 'resting');
        assert.strictEqual(soloRest.stats.partyMarketReturn, null,
            'resting recovery must also discard the obsolete party return token');
    } finally {
        SpotProfiles.findForState = previousFindSpot;
        SpotService.arrivalPointForState = previousArrival;
    }

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
}).finally(async () => {
    Database.reconcileBotClanMembership = originals.reconcileBotClanMembership;
    Database.reconcileBotClanGoals = originalReconcileClanGoals;
    Database.execute = originals.execute;
    Database.fetchItems = originals.fetchItems;
    Database.fetchMarketBuyerActivity = originals.fetchMarketBuyerActivity;
    Database.fetchWarehouseItems = originals.fetchWarehouseItems;
    Database.updateItemAmount = originals.updateItemAmount;
    Database.updateItemEquipState = originals.updateItemEquipState;
    Database.updateCharacterLocation = originals.updateCharacterLocation;
    Database.updateCharacterExperience = originals.updateCharacterExperience;
    Database.updateCharacterVitals = originals.updateCharacterVitals;
    Database.syncInventorySummary = originals.syncInventorySummary;
    Database.transferInventoryToWarehouse = originals.transferInventoryToWarehouse;
    LifeState.allStates = originals.allStates;
    LifeState.upsertState = originals.upsertState;
    LifeState.reset?.();
    await Database.close();
});
