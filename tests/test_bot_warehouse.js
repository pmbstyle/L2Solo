const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TradeService = invoke('GameServer/Bot/TradeService');
const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');
const ServerResponse = invoke('GameServer/Network/Response');

DataCache.init();

const originals = {
    fetchItems: Database.fetchItems,
    fetchWarehouseItems: Database.fetchWarehouseItems,
    transferInventoryToWarehouse: Database.transferInventoryToWarehouse,
    transferWarehouseToInventory: Database.transferWarehouseToInventory,
    execute: Database.execute,
    refreshInventory: LifeState.refreshInventory,
    upsertState: LifeState.upsertState,
    applyNpcLiquidation: LifeState.applyNpcLiquidation,
    applyWarehouseGearCleanup: LifeState.applyWarehouseGearCleanup,
    findByCharacterId: LifeState.findByCharacterId,
    statesByIds: LifeState.statesByIds,
    allStates: LifeState.allStates,
    bestBuyOffer: MarketOpportunity.bestBuyOffer,
    activeBuyDemandSelfIds: MarketOpportunity.activeBuyDemandSelfIds,
    deleteItem: Database.deleteItem,
    updateItemAmount: Database.updateItemAmount,
    itemsList: ServerResponse.itemsList,
    userInfo: ServerResponse.userInfo,
    speak: ServerResponse.speak
};

async function run() {
    const material = { selfId: 1870, name: 'Animal Bone', amount: 20, kind: 'Other.Material', rank: 'none' };
    const trash = { selfId: 1, name: 'Short Sword', amount: 1, kind: 'Weapon.Sword', rank: 'none' };
    const usefulGear = { selfId: 2, name: 'Long Sword', amount: 1, kind: 'Weapon.Sword', rank: 'none' };
    assert.strictEqual(ItemDisposition.isWarehouseCandidate(material), true, 'materials must be kept even when cheap');
    assert.strictEqual(ItemDisposition.isWarehouseCandidate(trash), false, 'cheap no-grade gear remains liquidation trash');
    assert.strictEqual(ItemDisposition.isWarehouseCandidate(usefulGear), true, 'valuable no-grade gear must survive an unsuccessful sale');

    const calls = [];
    Database.fetchItems = () => Promise.resolve([
        { id: 31, selfId: 1870, amount: 20, equipped: false },
        { id: 32, selfId: 2, amount: 1, equipped: false },
        { id: 33, selfId: 94, amount: 1, equipped: false },
        { id: 34, selfId: 94, amount: 1, equipped: false }
    ]);
    Database.transferInventoryToWarehouse = (characterId, item) => {
        calls.push({ characterId, ...item });
        return Promise.resolve({ inventoryAmount: 0, warehouseAmount: item.amount });
    };
    Database.fetchWarehouseItems = () => Promise.resolve([]);
    LifeState.applyNpcLiquidation = (coldState, candidates, options) => Promise.resolve({
        ...coldState,
        inventory: candidates.reduce((inventory, item) => ({
            ...inventory,
            [item.selfId]: {
                ...inventory[item.selfId],
                amount: Math.max(0, Number(inventory[item.selfId]?.amount || 0) - Number(item.count || 0))
            }
        }), { ...(coldState.inventory || {}) }),
        stats: { ...(coldState.stats || {}), lastNpcLiquidation: { source: options.source, sold: candidates } }
    });
    const state = {
        characterId: 55,
        inventory: {
            1870: material,
            1: trash,
            2: usefulGear,
            94: { selfId: 94, name: 'Bec de Corbin', amount: 2, kind: 'Weapon.Pole', rank: 'c' }
        },
        stats: {}
    };
    const result = await BotWarehouse.depositCold(state);
    assert.strictEqual(result.count, 23);
    assert.deepStrictEqual(calls.map((item) => item.selfId).sort((a, b) => a - b), [2, 94, 94, 1870]);
    assert.strictEqual(result.state.inventory['1870'].amount, 0);
    assert.strictEqual(result.state.inventory['2'].amount, 0);
    assert.strictEqual(result.state.inventory['94'].amount, 0, 'duplicate non-stackable gear must be deposited from separate item rows');
    assert.strictEqual(result.state.inventory['1'].amount, 1, 'low-level trash must remain available for NPC liquidation');
    assert.strictEqual(result.state.stats.lastWarehouseDeposit.items.length, 3);
    assert.strictEqual(BotWarehouse.retentionAmount({ ...usefulGear, amount: 4 }, 0), 2,
        'warehouse gear retention must preserve at most the two copies needed by dual-sword plans');
    assert.strictEqual(BotWarehouse.retentionAmount({ ...usefulGear, amount: 1 }, 2), 0,
        'warehouse gear retention must reject a third stored copy');
    assert.strictEqual(BotWarehouse.retentionAmount(material, 500), 20,
        'stackable crafting materials must remain outside the gear-copy cap');

    Database.fetchItems = () => Promise.resolve([
        { id: 35, selfId: 94, amount: 1, equipped: false },
        { id: 36, selfId: 94, amount: 1, equipped: false },
        { id: 37, selfId: 94, amount: 1, equipped: false }
    ]);
    Database.fetchWarehouseItems = () => Promise.resolve([
        { id: 70, selfId: 94, amount: 1 }
    ]);
    calls.length = 0;
    const capped = await BotWarehouse.depositCold({
        characterId: 55,
        inventory: {
            94: { selfId: 94, name: 'Bec de Corbin', amount: 3, kind: 'Weapon.Pole', rank: 'c' }
        },
        stats: {}
    });
    assert.strictEqual(capped.count, 1, 'only the remaining warehouse gear allowance may be deposited');
    assert.strictEqual(capped.overflow[0].count, 2, 'surplus gear must be reported for value-preserving NPC liquidation');
    assert.strictEqual(capped.state.inventory['94'].amount, 0, 'surplus cold gear must leave inventory after liquidation');
    assert.strictEqual(capped.state.stats.lastNpcLiquidation.source, 'warehouse_retention_overflow');
    const depositCalls = calls.length;
    const ownedDeposit = await BotWarehouse.depositCold({
        ...state,
        simulation: { ownerId: 'cold_simulation_owner', revision: 1, leaseId: 'lease', leaseUntil: Date.now() + 1000 }
    });
    assert.strictEqual(ownedDeposit.count, 0, 'cold warehouse deposit must defer while the logical owner holds the row');
    assert.strictEqual(calls.length, depositCalls, 'deferred warehouse deposit must not mutate inventory rows');

    const liveItem = (id, item, equipped = false) => ({
        id,
        ...item,
        equipped,
        fetchId() { return this.id; },
        fetchSelfId() { return this.selfId; },
        fetchName() { return this.name; },
        fetchAmount() { return this.amount; },
        fetchKind() { return this.kind; },
        fetchRank() { return this.rank; },
        fetchEquipped() { return this.equipped; },
        fetchStackable() { return this.stackable; }
    });
    const saber = { selfId: 123, name: 'Saber', amount: 1, kind: 'Weapon.Sword', rank: 'd', stackable: false };
    const liveItems = [
        liveItem(41, { ...material, stackable: true }),
        liveItem(42, { ...trash, stackable: false }),
        liveItem(43, saber, true),
        liveItem(44, saber),
        liveItem(45, saber)
    ];
    const liveBackpack = { items: liveItems, fetchItems() { return this.items; } };
    const liveState = {
        stats: {
            equipmentPlan: {
                status: 'ready_to_craft',
                strategy: 'craft',
                combine: { requirements: [{ selfId: 123, amount: 2 }] }
            }
        }
    };
    const liveActor = {
        fetchId: () => 56,
        backpack: liveBackpack
    };
    Database.fetchWarehouseItems = () => Promise.resolve([
        { id: 68, selfId: 123, amount: 1 },
        { id: 69, selfId: 123, amount: 1 }
    ]);
    const preview = TradeService.previewSaleToStore(liveActor, {
        storeType: 3,
        items: [{ selfId: 123, count: 3, price: 1000 }]
    }, { state: liveState });
    assert.strictEqual(preview.itemCount, 1, 'hot private-store sales must expose only swords beyond the active combination reserve');

    const live = await BotWarehouse.depositActor(liveActor, liveState);
    assert.strictEqual(live.count, 20, 'active bots must store materials without adding a third warehouse gear copy');
    assert.deepStrictEqual(liveBackpack.items.map((item) => item.selfId), [1, 123, 123, 123],
        'equipped, reserved, and warehouse-overflow swords must survive until the existing NPC sell step');

    let warehouseRows = [{ id: 71, selfId: 5220, name: 'Metal Hardener', amount: 60 }];
    const withdrawals = [];
    Database.fetchWarehouseItems = () => Promise.resolve(warehouseRows.map((row) => ({ ...row })));
    Database.transferWarehouseToInventory = (characterId, item) => {
        withdrawals.push({ characterId, ...item });
        warehouseRows = warehouseRows.map((row) => Number(row.id) === Number(item.id)
            ? { ...row, amount: row.amount - item.amount }
            : row).filter((row) => row.amount > 0);
        return Promise.resolve({ inventoryAmount: item.amount, warehouseAmount: warehouseRows[0]?.amount || 0 });
    };
    LifeState.refreshInventory = (coldState) => Promise.resolve({
        ...coldState,
        inventory: withdrawals.reduce((inventory, item) => ({
            ...inventory,
            [item.selfId]: { selfId: item.selfId, name: item.name, amount: item.amount, kind: 'Other.Material', stackable: true }
        }), { ...(coldState.inventory || {}) })
    });
    LifeState.upsertState = (coldState) => Promise.resolve(coldState);
    MarketOpportunity.bestBuyOffer = () => ({ count: 50, town: 'Giran' });
    const craftRelease = await BotWarehouse.releaseCold({
        characterId: 58,
        name: 'CraftOwner',
        phase: 'cold',
        activity: 'hunting',
        inventory: {},
        timing: { nextResolveAt: 999999 },
        stats: {
            equipmentPlan: {
                status: 'active',
                strategy: 'craft',
                materials: [{ selfId: 5220, amount: 60, owned: 0, missing: 60 }]
            }
        }
    });
    assert.strictEqual(craftRelease.released, true);
    assert.deepStrictEqual(craftRelease.items.map((item) => [item.reason, item.amount]), [['craft', 60]],
        'an owner recipe must reserve its full stored requirement before market demand is considered');
    assert.strictEqual(craftRelease.state.inventory[5220].amount, 60);
    assert(craftRelease.state.timing.nextResolveAt <= Date.now(), 'released craft materials must make a hunting bot due for replanning');

    warehouseRows = [{ id: 72, selfId: 5220, name: 'Metal Hardener', amount: 100 }];
    withdrawals.length = 0;
    const marketRelease = await BotWarehouse.releaseCold({
        characterId: 59,
        name: 'WarehouseSeller',
        phase: 'cold',
        activity: 'hunting',
        inventory: {},
        timing: {},
        stats: { marketSellRetryAfter: Date.now() + 15 * 60 * 1000 }
    });
    assert.deepStrictEqual(marketRelease.items.map((item) => [item.reason, item.amount]), [['market', 50]],
        'warehouse release must expose only the currently funded WTB quantity');
    assert.strictEqual(warehouseRows[0].amount, 50, 'unfunded warehouse surplus must remain stored');
    assert.strictEqual(marketRelease.state.stats.marketSellRetryAfter, null,
        'new funded WTB demand must clear a stale no-demand sale cooldown');
    const withdrawalsBeforeFence = withdrawals.length;
    const ownedRelease = await BotWarehouse.releaseCold({
        ...marketRelease.state,
        simulation: { ownerId: 'cold_simulation_owner', revision: 1, leaseId: 'lease', leaseUntil: Date.now() + 1000 }
    });
    assert.strictEqual(ownedRelease.released, false, 'warehouse release must remain legacy-main while a cold lease is active');
    assert.strictEqual(withdrawals.length, withdrawalsBeforeFence, 'warehouse ownership fence must prevent physical item writes');
    const pendingSeller = {
        ...marketRelease.state,
        stats: {
            ...marketRelease.state.stats,
            marketSellRetryAfter: Date.now() + 15 * 60 * 1000
        }
    };
    LifeState.allStates = () => [pendingSeller, {
        ...pendingSeller,
        characterId: 60,
        simulation: { ownerId: 'cold_simulation_owner', revision: 1, leaseId: 'lease', leaseUntil: Date.now() + 1000 }
    }];
    assert.deepStrictEqual(BotWarehouse.pendingMarketReleaseCandidates(2).map((state) => state.characterId), [59],
        'a funded material already released before restart must be resumed from its stale cooldown');
    const resumedSeller = await BotWarehouse.resumeReleasedMarket(pendingSeller, 12345);
    assert.strictEqual(resumedSeller.state.stats.marketSellRetryAfter, null);
    assert.strictEqual(resumedSeller.state.timing.nextResolveAt, 12345);

    let candidateQuery = null;
    MarketOpportunity.activeBuyDemandSelfIds = () => [5220];
    Database.execute = (statement) => {
        candidateQuery = statement;
        return Promise.resolve([{ characterId: 59 }]);
    };
    assert.deepStrictEqual(await BotWarehouse.releaseCandidates(3), [59]);
    assert(candidateQuery[0].includes('LIMIT 3'), 'warehouse scanning must remain bounded by the scheduler batch');
    assert(candidateQuery[0].includes("states.simulationOwner = 'legacy_main'"), 'warehouse candidate SQL must exclude leased owner rows');
    assert.deepStrictEqual(candidateQuery[1], [5220], 'only currently funded material demand should enter the warehouse scan');
    LifeState.allStates = () => [{
        characterId: 58,
        phase: 'cold',
        activity: 'hunting',
        party: {},
        stats: { equipmentPlan: { status: 'active', strategy: 'craft' } }
    }, {
        characterId: 60,
        phase: 'cold',
        activity: 'hunting',
        party: {},
        stats: { equipmentPlan: { status: 'active', strategy: 'market' } }
    }, {
        characterId: 61,
        phase: 'cold',
        activity: 'hunting',
        party: {},
        simulation: { ownerId: 'cold_simulation_owner', revision: 1, leaseId: 'lease', leaseUntil: Date.now() + 1000 },
        stats: { equipmentPlan: { status: 'active', strategy: 'craft' } }
    }];
    assert.deepStrictEqual(BotWarehouse.craftReleaseCandidates(1, 100).map((state) => state.characterId), [58],
        'the bounded in-memory rotation must inspect only active craft owners');

    LifeState.allStates = () => [];
    Database.execute = (statement) => statement[0].includes('warehouse.selfId IN')
        ? Promise.resolve([{ characterId: 59 }, { characterId: 60 }])
        : Promise.resolve([]);
    let hydratedIds = null;
    LifeState.statesByIds = (ids, options) => {
        hydratedIds = { ids, options };
        return Promise.resolve(ids.map((characterId) => ({
            characterId, name: `Hydrated${characterId}`, phase: 'cold', activity: 'hunting', party: {}, stats: {}
        })));
    };
    Database.fetchWarehouseItems = () => Promise.resolve([]);
    await BotWarehouse.releaseColdBatch(2);
    assert.deepStrictEqual(hydratedIds.ids, [59, 60], 'warehouse candidates must hydrate in one bounded state query');
    assert.deepStrictEqual(hydratedIds.options, { ownerId: 'legacy_main', unassigned: true });

    const historicalRows = [
        { id: 81, selfId: 94, name: 'Bec de Corbin', amount: 1, enchant: 0 },
        { id: 82, selfId: 94, name: 'Bec de Corbin', amount: 1, enchant: 3 },
        { id: 83, selfId: 94, name: 'Bec de Corbin', amount: 1, enchant: 1 },
        { id: 84, selfId: 94, name: 'Bec de Corbin', amount: 1, enchant: 2 },
        { id: 85, selfId: 1870, name: 'Animal Bone', amount: 500, enchant: 0 }
    ];
    const historicalOverflow = BotWarehouse.historicalGearOverflow(historicalRows, 16);
    assert.deepStrictEqual(historicalOverflow.map((item) => [item.id, item.enchant]), [[83, 1], [81, 0]],
        'historical cleanup must keep the two best enchanted copies and ignore material stacks');
    assert.deepStrictEqual(BotWarehouse.historicalGearOverflow(historicalRows, 1).map((item) => item.id), [83],
        'historical cleanup must stop at its per-owner unit budget');

    let cleanupRequest = null;
    Database.fetchWarehouseItems = () => Promise.resolve(historicalRows.map((row) => ({ ...row })));
    LifeState.applyWarehouseGearCleanup = (characterId, selections, cleanupOptions) => {
        cleanupRequest = { characterId, selections, cleanupOptions };
        return Promise.resolve({ ok: true, characterId, rowsRemoved: selections.length, units: selections.length, payout: 123 });
    };
    const historicalCleanup = await BotWarehouse.cleanupHistoricalOwner(77, 1);
    assert.strictEqual(historicalCleanup.units, 1);
    assert.strictEqual(cleanupRequest.characterId, 77);
    assert.deepStrictEqual(cleanupRequest.selections.map((item) => item.id), [83]);
    assert.strictEqual(cleanupRequest.cleanupOptions.source, 'historical_gear_retention');

    Database.execute = (statement) => {
        candidateQuery = statement;
        return Promise.resolve([{ characterId: 101 }, { characterId: 102 }]);
    };
    assert.deepStrictEqual(await BotWarehouse.historicalCleanupCandidates(100, 3), [101, 102]);
    assert(candidateQuery[0].includes('LIMIT 3'), 'historical owner discovery must remain a bounded cursor query');
    assert(candidateQuery[0].includes('INDEXED BY warehouse_items_characterId'),
        'historical owner discovery must stay warehouse-index driven instead of rescanning life-state owners');
    assert(candidateQuery[0].includes("states.simulationOwner = 'legacy_main'"), 'historical cleanup must discover only legacy-main owners');
    assert.deepStrictEqual(candidateQuery[1], [100]);

    const adena = liveItem(50, { selfId: 57, name: 'Adena', amount: 100, stackable: true });
    adena.setAmount = (amount) => { adena.amount = amount; };
    const junkBackpack = {
        items: [
            liveItem(51, { ...trash, stackable: false, fetchPrice: () => 10 }),
            liveItem(52, saber, true),
            liveItem(53, saber),
            adena
        ],
        fetchItems() { return this.items; },
        stackableExists: () => Promise.resolve(adena)
    };
    Database.deleteItem = () => Promise.resolve();
    Database.updateItemAmount = () => Promise.resolve();
    ServerResponse.itemsList = ServerResponse.userInfo = ServerResponse.speak = () => Buffer.alloc(0);
    SellJunk({
        actor: { fetchId: () => 57, backpack: junkBackpack },
        coldLifeState: liveState,
        dataSendToMe() {}
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(junkBackpack.items.map((item) => item.id), [52, 53, 50],
        'sell-junk must remove only sold object rows and retain the reserved source sword');
    console.log('Bot warehouse checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Database.fetchItems = originals.fetchItems;
    Database.fetchWarehouseItems = originals.fetchWarehouseItems;
    Database.transferInventoryToWarehouse = originals.transferInventoryToWarehouse;
    Database.transferWarehouseToInventory = originals.transferWarehouseToInventory;
    Database.execute = originals.execute;
    LifeState.refreshInventory = originals.refreshInventory;
    LifeState.upsertState = originals.upsertState;
    LifeState.applyNpcLiquidation = originals.applyNpcLiquidation;
    LifeState.applyWarehouseGearCleanup = originals.applyWarehouseGearCleanup;
    LifeState.findByCharacterId = originals.findByCharacterId;
    LifeState.statesByIds = originals.statesByIds;
    LifeState.allStates = originals.allStates;
    MarketOpportunity.bestBuyOffer = originals.bestBuyOffer;
    MarketOpportunity.activeBuyDemandSelfIds = originals.activeBuyDemandSelfIds;
    Database.deleteItem = originals.deleteItem;
    Database.updateItemAmount = originals.updateItemAmount;
    ServerResponse.itemsList = originals.itemsList;
    ServerResponse.userInfo = originals.userInfo;
    ServerResponse.speak = originals.speak;
});
