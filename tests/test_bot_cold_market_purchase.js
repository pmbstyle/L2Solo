const assert = require('assert');

require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fixtureFs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fixtureFs.rmSync(fixture.directory, { recursive: true, force: true }));
const NativeChoice = require('./helpers/nativeMarketChoice');
const Native = require('./helpers/nativeMarketFixture');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const originalFullEconomy = Economy.forState;

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const originalReconcileClanGoals = Database.reconcileBotClanGoals;
const World = invoke('GameServer/World/World');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotGear = invoke('GameServer/Bot/AI/BotGear');

DataCache.init();

const originals = {
    reconcileBotClanMembership: Database.reconcileBotClanMembership,
    execute: Database.execute,
    fetchItems: Database.fetchItems,
    updateItemAmount: Database.updateItemAmount,
    updateItemEquipState: Database.updateItemEquipState,
    setItem: Database.setItem,
    syncInventorySummary: Database.syncInventorySummary,
    updateCharacterLocation: Database.updateCharacterLocation,
    updateCharacterExperience: Database.updateCharacterExperience,
    updateCharacterVitals: Database.updateCharacterVitals,
    clearGoal: GoalState.clear,
    user: World.user,
    bestOffer: MarketOpportunity.bestOffer,
    npcOffers: MarketOpportunity.npcOffers,
    reserve: MarketOpportunity.reserve,
    openBuyStore: BuyStoreService.open
};

const calls = [];
const playerStore = {
    storeType: 1,
    town: 'Giran',
    items: [{ selfId: 2, price: 1000, count: 1 }]
};

async function run() {
    // ARCH-NOTE: native prepared writers need real declared SQL identities and bags.
    // The raw execution seams below do not claim a selected/funded shopping wish.
    Database.init();
    for (const id of [77, 777, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 91, 92]) {
        await Native.character(Database, id, 'ColdBuyer' + id, 'bot_' + id);
    }
    await Native.character(Database, 9001, 'RareSupplier', 'bot_raresupplier');
    await Native.character(Database, 9002, 'PlayerLowGradeSeller', 'player_low_grade_seller');
    Database.reconcileBotClanMembership = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.updateCharacterLocation = async () => {};
    Database.updateCharacterExperience = async () => {};
    Database.updateCharacterVitals = async () => {};
    MarketTelemetry.reset();
    Economy.forState = function (value, ...args) {
        if (value?.phase === 'cold') throw new Error('fixture forbids main cold wish builds');
        return originalFullEconomy.call(this, value, ...args);
    };
    Database.syncInventorySummary = async (characterId, inventory, ...args) => {
        calls.push({ type: 'inventory-sync', characterId, inventory });
        return originals.syncInventorySummary.call(Database, characterId, inventory, ...args);
    };
    async function declaredState(value, label) {
        // Each reused id is an independent original scenario; install its
        // exact declared bag, without retaining another scenario's purchases.
        await originals.execute.call(Database, ['DELETE FROM items WHERE characterId = ?', [value.characterId]]);
        await originals.syncInventorySummary.call(Database, value.characterId, value.inventory || {}, 'fixture_declared_input');
        const originalInput = structuredClone(value);
        await BotLifeState.upsertState(value, 'fixture_' + label);
        assert.deepStrictEqual(value, originalInput, 'native materialization does not retune the original scenario input');
        assert.strictEqual(Native.amount(await originals.fetchItems.call(Database, value.characterId), 57), Number(value.adena));
        return value;
    }
    async function publicSword(owner, ownerName, price) {
        const stockId = Number((await Database.setItem(owner, { selfId: 2, name: 'Long Sword', amount: 1 })).insertId);
        const beforeSeller = await Database.fetchItems(owner);
        const record = await Afk.publishBot(owner, { kind: 'shop', storeType: Afk.SELL, town: 'Giran', title: 'Long Sword',
            locX: 83000, locY: 148000, locZ: -3400, appearance: { model: { name: ownerName } },
            lines: [{ objectId: stockId, selfId: 2, name: 'Long Sword', count: 1, price, stackable: false }] });
        assert(Number.isSafeInteger(record.id) && record.id > 0);
        return { record, beforeSeller };
    }
    async function executePublicSword(value, owner, ownerName, price, label) {
        const buyer = await declaredState(value, label);
        const beforeBuyer = await Database.fetchItems(buyer.characterId);
        const { record, beforeSeller } = await publicSword(owner, ownerName, price);
        // Database.openBoardRecordUnsafe takes physical stock into the line.
        // The before state includes that sword before publish reserves it.
        const [storedBefore] = await Database.execute(['SELECT selfId, count, initialCount, fills FROM afk_trade_lines WHERE shopId = ?', [record.id]]);
        assert.deepStrictEqual([Number(storedBefore.selfId), Number(storedBefore.count), Number(storedBefore.initialCount), Number(storedBefore.fills)], [2, 1, 1, 0]);
        assert.strictEqual(Native.amount(await Database.fetchItems(owner), 2), Native.amount(beforeSeller, 2) - 1,
            'publish reserves exactly the original physical sword into the public line');
        const offer = MarketOpportunity.bestOffer(2, { town: 'Giran', buyerCharacterId: buyer.characterId });
        assert.strictEqual(offer.recordId, record.id);
        assert.deepStrictEqual([offer.selfId, offer.price, offer.count], [2, price, 1]);
        const refused = await ColdMarketService.buyOffer(buyer, { ...offer, buyerCharacterId: buyer.characterId, equipSlot: 7 });
        assert.strictEqual(refused.purchased, false, 'the unchanged raw input has no admitted funding packet');
        assert.strictEqual(Native.amount(await Database.fetchItems(buyer.characterId), 57), value.adena,
            'E2 refusal does not spend the declared wallet');
        assert.strictEqual(Native.amount(await Database.fetchItems(buyer.characterId), 2), 0);
        // ARCH-NOTE: this unmarked native transaction isolates the legacy
        // physical SQL seam. It proves payment/stock conservation and item
        // reconciliation only; no worker choice, funding packet or E2 receipt
        // is supplied. Admitted replay-safe success has its own native fixture.
        const physical = await Database.buyFromAfkTradeShop(buyer.characterId, {
            shopId: record.id, ownerId: owner, lineId: offer.lineId, amount: 1,
            expectedPrice: price, expectedRevision: record.revision
        });
        assert.strictEqual(physical.committed, true);
        assert.strictEqual(physical.economyCommit, undefined, 'raw SQL seam does not invent an admitted receipt');
        Afk.refreshRecord(physical.shop);
        const captured = physical.coldLifeRows?.[buyer.characterId]
            ? BotLifeState.acceptLifecycleRow(physical.coldLifeRows[buyer.characterId]) : refused.state || buyer;
        const synced = await BotLifeState.syncExternalInventory(buyer.characterId, 'afk_trade_raw_fixture', captured);
        assert(synced, 'committed physical holdings reconcile into the existing equipment owner');
        MarketTelemetry.purchase(offer, 1, { buyerCharacterId: buyer.characterId, buyerName: buyer.name, town: buyer.currentRegion });
        const result = { purchased: true, state: synced, offer, units: 1, spent: price, rawPhysicalBaseline: true };
        const afterBuyer = await Database.fetchItems(buyer.characterId), afterSeller = await Database.fetchItems(owner);
        // A full fill closes and deletes the shop and its lines. The
        // durable sale event is in history, read after its native flush.
        const linesAfter = await Database.execute(['SELECT id FROM afk_trade_lines WHERE shopId = ?', [record.id]]);
        const shopsAfter = await Database.execute(['SELECT id FROM afk_trade_shops WHERE id = ?', [record.id]]);
        assert.deepStrictEqual(linesAfter, [], 'a full native fill removes the exhausted line');
        assert.deepStrictEqual(shopsAfter, [], 'a full native fill removes the closed shop');
        const saleEvents = await Database.readHistory(['SELECT id, ownerId, counterpartyId, kind, selfId, itemName, amount, unitPrice, totalPrice FROM afk_trade_events WHERE shopId = ? ORDER BY id', [record.id]]);
        assert.deepStrictEqual(saleEvents.map(row => [row.ownerId, row.counterpartyId, row.kind, row.selfId,
            row.itemName, row.amount, row.unitPrice, row.totalPrice]),
            [[owner, buyer.characterId, 'sale', 2, 'Long Sword', 1, price, price]],
            'exactly one durable native sale records the original parties, sword, quantity and payment');
        assert(Number.isSafeInteger(saleEvents[0].id) && saleEvents[0].id > 0);
        assert.strictEqual(Native.amount(afterBuyer, 57), value.adena - price);
        assert.strictEqual(Native.amount(afterBuyer, 2), 1);
        assert.strictEqual(Native.amount(afterSeller, 57) - Native.amount(beforeSeller, 57), price);
        assert.strictEqual(Native.amount(beforeBuyer, 57) + Native.amount(beforeSeller, 57),
            Native.amount(afterBuyer, 57) + Native.amount(afterSeller, 57), 'physical public payment conservation');
        assert.strictEqual(Native.amount(beforeBuyer, 2) + Native.amount(beforeSeller, 2),
            Native.amount(afterBuyer, 2) + Native.amount(afterSeller, 2), 'physical public Long Sword conservation');
        assert.strictEqual(Number(afterBuyer.find(row => Number(row.selfId) === 1).equipped), 0);
        assert.strictEqual(Number(afterBuyer.find(row => Number(row.selfId) === 2).equipped), 1);
        console.log('Native public purchase:', JSON.stringify({ label, buyer: buyer.characterId, owner, price,
            walletBefore: Native.amount(beforeBuyer, 57), walletAfter: Native.amount(afterBuyer, 57),
            sellerCredit: Native.amount(afterSeller, 57) - Native.amount(beforeSeller, 57), sword: Native.amount(afterBuyer, 2),
            persistedSaleId: saleEvents[0].id, remainingShopRows: shopsAfter.length, remainingLineRows: linesAfter.length }));
        return { result, afterBuyer, afterSeller };
    }
    GoalState.clear = (characterId, status) => {
        calls.push({ type: 'goal', characterId, status });
        return Promise.resolve(null);
    };
    // Group F/E14: this configured non-shot private input is retired; the
    // separate declared public counterpart below is a genuine native deal.
    World.user = { sessions: [{
        accountId: 'bot_raresupplier',
        actor: {
            fetchId: () => 9001,
            fetchName: () => 'RareSupplier',
            fetchPrivateStore: () => playerStore
        }
    }] };

    const state = {
        characterId: 77,
        accountName: 'bot_77',
        name: 'ColdBuyer',
        level: 40,
        adena: 1000,
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Giran',
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 1000 },
            1: { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7, rank: 'none', kind: 'Weapon.Sword' }
        },
        stats: {
            equipment: [{ selfId: 1, slot: 7, rank: 'none', kind: 'Weapon.Sword' }],
            equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 2, name: 'Long Sword', slot: 7 } },
            partyRequest: { status: 'open', priority: 'required' },
            marketWanted: { itemId: 2, itemName: 'Long Sword', lastMissingAt: Date.now() }
        },
        loc: {},
        vitals: {},
        timing: {}
    };
    const goal = { type: 'upgrade_gear', target: { itemId: 2 } };
    // ARCH-NOTE: FX-C1/E3 require a genuine worker packet, not a flat reserve.
    const nativeOriginal = await NativeChoice.capture(state, {}, 'cold_purchase_original_1000');
    assert.strictEqual(Funding.spendable(nativeOriginal.state, 0, { itemId: 2 }), 0);
    const negativeBuyer = await declaredState(nativeOriginal.state, 'original_unfunded');
    const unfunded = await ColdMarketService.tryPurchase(negativeBuyer, goal);
    assert.strictEqual(unfunded.purchased, false, 'the actual queue does not fund this item');
    assert.strictEqual(Native.amount(await Database.fetchItems(77), 57), 1000);
    assert.strictEqual(Native.amount(await Database.fetchItems(77), 2), 0);
    assert.strictEqual(playerStore.items[0].count, 1);
    calls.length = 0;
    const privateBefore = JSON.stringify(state);
    const retired = await ColdMarketService.buyOffer(state, { selfId: 2, price: 1000, count: 1,
        sourceType: 'private_store', sourceId: 9001, sourceName: 'RareSupplier', sellerKind: 'fixed',
        storeItem: playerStore.items[0], buyerCharacterId: 77, equipSlot: 7 });
    assert.deepStrictEqual(retired, { purchased: false, blocked: true, reason: 'configured_supply_retired' });
    assert.strictEqual(JSON.stringify(state), privateBefore);
    assert.strictEqual(playerStore.items[0].count, 1);
    assert.deepStrictEqual(calls, [], 'retired fixed stock reaches no inventory writer');
    // Explicit raw execution seam: exact original owner/item/wallet/price/qty,
    // with physical public stock. This is not a native selected shopping leaf.
    const firstPublic = await executePublicSword(state, 9001, 'RareSupplier', 1000, 'public_original_1000');
    const result = firstPublic.result;
    assert.strictEqual(result.purchased, true);
    assert.strictEqual(result.state.adena, 0);
    assert.strictEqual(result.state.inventory['57'], undefined,
        'spent Adena must not remain as a zero-amount durable inventory entry');
    assert.strictEqual(result.state.inventory['1'].equipped, false);
    assert.strictEqual(result.state.inventory['2'].equipped, true);
    assert.strictEqual(result.state.stats.equipment[0].selfId, 2);
    assert.strictEqual(result.state.stats.equipmentPlan, undefined, 'a purchased equipped target must immediately finish its stale acquisition plan');
    assert.strictEqual(result.state.stats.partyRequest, undefined, 'fulfilling a gear target must clear its obsolete party request');
    assert.strictEqual(result.state.stats.marketWanted, null, 'fulfilled demand must leave the market index immediately');
    assert.strictEqual(playerStore.items[0].count, 1, 'public trade never consumes the retired private stock');
    assert.strictEqual(Native.amount(firstPublic.afterBuyer, 57), 0, 'native inventory persists spent Adena');
    assert.strictEqual(Number(firstPublic.afterBuyer.find(row => Number(row.selfId) === 1).equipped), 0);
    assert.strictEqual(Number(firstPublic.afterBuyer.find(row => Number(row.selfId) === 2).equipped), 1);
    // The original 11,000 wallet is not a funding proof under E3. Preserve it
    // as a real queue refusal, then test its separate raw public execution.
    const oldFundedInput = { ...state, characterId: 777, adena: 11000,
        inventory: { ...state.inventory, 57: { selfId: 57, name: 'Adena', amount: 11000 } } };
    const nativeFunded = await NativeChoice.capture(oldFundedInput, {}, 'cold_purchase_original_11000');
    assert.strictEqual(Funding.spendable(nativeFunded.state, 0, { itemId: 2 }), 0);
    const funded = await ColdMarketService.tryPurchase(await declaredState(nativeFunded.state, 'original_11000'), goal);
    assert.strictEqual(funded.purchased, false);
    assert.strictEqual(Native.amount(await Database.fetchItems(777), 57), 11000);
    assert.strictEqual(Native.amount(await Database.fetchItems(777), 2), 0);
    assert(!calls.some(call => call.type === 'goal' && call.characterId === 777 && call.status === 'completed'),
        'unfunded shopping does not report a completed purchase');
    await executePublicSword(oldFundedInput, 9001, 'RareSupplier', 1000, 'public_original_11000');
    const playerTransactions = MarketTelemetry.transactions();
    const purchaseTrade = playerTransactions.recentPeerTrades[0];
    assert.strictEqual(purchaseTrade.channel, 'wts');
    assert.strictEqual(purchaseTrade.itemName, 'Long Sword');
    assert.strictEqual(purchaseTrade.seller.name, 'RareSupplier');
    assert.strictEqual(purchaseTrade.buyer.name, 'ColdBuyer');
    assert.strictEqual(purchaseTrade.town, 'Giran');
    assert.strictEqual(playerTransactions.recentPeerTrades.length, 2, 'two genuine public bot deals have peer telemetry');
    assert.strictEqual(playerTransactions.recentPlayerTrades.length, 0, 'retired configured supply has no transaction');
    assert.strictEqual(MarketTelemetry.current().peerPurchases, 2);

    const lowTierMarketLookups = [];
    let lowTierBudget;
    MarketOpportunity.bestOffer = (_itemId, options) => {
        lowTierMarketLookups.push(options);
        lowTierBudget = options.budget;
        const offer = {
            selfId: 2,
            itemName: 'Long Sword',
            price: 900,
            sourceType: 'private_store',
            sourceId: 9002,
            sourceName: 'PlayerLowGradeSeller',
            sellerKind: 'player',
            available: true,
            storeItem: { selfId: 2, price: 900, count: 1 }
        };
        return offer.price <= options.budget ? offer : null;
    };
    MarketOpportunity.reserve = () => true;
    const lowTierInput = { ...state, characterId: 88, level: 14 };
    const lowTierNative = await NativeChoice.capture(lowTierInput, {}, 'cold_purchase_original_level14');
    const lowTierState = await declaredState(lowTierNative.state, 'low_tier');
    // The native bot also probes public offers while checking remote-trade
    // eligibility. Count this consumer separately from capture/preparation.
    lowTierMarketLookups.length = 0; lowTierBudget = undefined;
    const lowTierPlayerPurchase = await ColdMarketService.tryPurchase(lowTierState, {
        type: 'upgrade_gear',
        status: 'active',
        target: { itemId: 2, itemName: 'Long Sword', itemSlot: 7, requiredRank: 'none' },
        plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Giran' }
    });
    assert.strictEqual(lowTierPlayerPurchase.purchased, false);
    assert.strictEqual(lowTierBudget, Funding.spendable(lowTierNative.state, 0, { itemId: 2 }));
    assert(lowTierBudget < 900, 'the unchanged cheaper quote is still outside the real queue');
    assert.strictEqual(lowTierPlayerPurchase.reason, 'low_tier_offer_missing');
    assert.strictEqual(Native.amount(await Database.fetchItems(88), 57), 1000);
    assert.strictEqual(Native.amount(await Database.fetchItems(88), 2), 0);
    assert.strictEqual(lowTierMarketLookups.filter(lookup => typeof lookup.cost !== 'function').length, 1,
        'NG/D purchase consumer performs one indexed market lookup');
    assert.strictEqual(lowTierMarketLookups.filter(lookup => typeof lookup.cost === 'function').length, 1,
        'native bot remote-trade eligibility separately observes the same public quote');
    assert(lowTierMarketLookups.every(lookup => lookup.budget === lowTierBudget),
        'neither public lookup fabricates funding for the original quote');
    MarketOpportunity.bestOffer = originals.bestOffer;
    MarketOpportunity.reserve = originals.reserve;
    // Separate public counterpart keeps the low-tier seller id/name, 900
    // quote, original wallet and one sword; raw execution is not AI approval.
    const cheaperPublic = await executePublicSword(lowTierInput, 9002, 'PlayerLowGradeSeller', 900, 'public_level14');
    // The original player_low_grade_seller account does not have bot_ prefix.
    // The public board classifies its native owner, not the publish API name.
    assert.strictEqual(cheaperPublic.result.offer.sourceType, 'afk_player_store');
    assert.strictEqual(cheaperPublic.result.state.adena, 100);

    let lowTierBuyStoreCalls = 0;
    MarketOpportunity.bestOffer = () => null;
    BuyStoreService.open = () => {
        lowTierBuyStoreCalls += 1;
        return Promise.resolve({ opened: true });
    };
    const missingLowTierNpcGear = await ColdMarketService.tryPurchase(await declaredState({
        ...state,
        characterId: 87,
        level: 14,
        stats: {
            ...state.stats,
            equipmentPlan: {
                status: 'complete', reason: 'npc_adequate_kit', strategy: 'none'
            },
            marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' }
        }
    }, 'missing_low_tier'), {
        type: 'upgrade_gear',
        status: 'active',
        target: { itemId: 945, itemName: 'Skeleton Buckler', itemSlot: 8, requiredRank: 'none' },
        plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Giran' }
    });
    assert.strictEqual(missingLowTierNpcGear.reason, 'low_tier_offer_missing');
    assert.strictEqual(lowTierBuyStoreCalls, 0, 'missing NG/D gear must replan instead of opening a WTB store');
    assert.strictEqual(missingLowTierNpcGear.state.activity, 'traveling');
    MarketOpportunity.npcOffers = originals.npcOffers;
    MarketOpportunity.bestOffer = originals.bestOffer;
    MarketOpportunity.reserve = originals.reserve;
    BuyStoreService.open = originals.openBuyStore;

    const completedGoal = await ColdMarketService.tryPurchase(state, {
        ...goal,
        status: 'completed',
        plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Giran' }
    });
    assert.strictEqual(completedGoal.reason, 'no_purchase_goal', 'a completed market goal must not buy its item again during a batch visit');
    // Town trips are paid (N2, user 2026-10-04): the bot shopping in Giran walks
    // to the Giran gatekeeper and pays the hop to the requested town.
    // ARCH-NOTE: preserve this legacy journey's original bot77 account marker.
    // The new bot_77 receipt identity additionally admits remote-trade planning,
    // which is a different route consumer; these are raw gatekeeper assertions.
    const legacyJourneyState = { ...state, accountName: 'bot77' };
    const fundedInGiran = { ...legacyJourneyState, adena: 100000, loc: { locX: 83396, locY: 147904, locZ: -3404 },
        inventory: { ...state.inventory, 57: { selfId: 57, name: 'Adena', amount: 100000 } } };
    const otherTownGoal = await ColdMarketService.tryPurchase(await declaredState(fundedInGiran, 'giran_to_dion'), {
        ...goal,
        status: 'active',
        plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Dion' }
    });
    assert.strictEqual(otherTownGoal.reason, 'market_destination_corrected', 'a stale journey must continue to the requested town');
    assert.strictEqual(otherTownGoal.state.stats.travel.townName, 'Dion');
    assert.strictEqual(otherTownGoal.state.adena, 100000 - 8100, 'the corrected journey pays the Giran to Dion gatekeeper');
    const shortOfFee = await ColdMarketService.tryPurchase(await declaredState({ ...fundedInGiran, adena: 1000, inventory: state.inventory }, 'short_gatekeeper'), {
        ...goal, status: 'active', plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Dion' }
    });
    assert.strictEqual(shortOfFee.reason, 'different_market_town', 'a buyer short of the gatekeeper fee stays (N2)');
    const returnPoint = { loc: { locX: 100, locY: 200, locZ: 0 }, regionName: 'Field' };
    const corrected = await ColdMarketService.tryPurchase(await declaredState({
        ...fundedInGiran, stats: { ...state.stats, marketReturn: returnPoint }
    }, 'corrected_goddard'), { ...goal, plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Goddard' } });
    assert.strictEqual(corrected.state.stats.travel.townName, 'Goddard');
    assert.deepStrictEqual(corrected.state.stats.marketReturn, returnPoint,
        'correcting a persisted wrong-town journey must keep the original hunting return');
    const unknownTown = await ColdMarketService.tryPurchase(await declaredState(legacyJourneyState, 'unknown_town'), {
        ...goal, plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Unknown town' }
    });
    assert.strictEqual(unknownTown.reason, 'different_market_town');
    assert(unknownTown.state.stats.marketRetryAfter > Date.now(),
        'an unavailable destination must back off instead of immediately repeating');

    let blockedReserveCalls = 0;
    MarketOpportunity.bestOffer = () => ({ selfId: 626, price: 24090, sourceType: 'npc' });
    MarketOpportunity.reserve = () => {
        blockedReserveCalls += 1;
        return true;
    };
    const incompatibleShield = await ColdMarketService.tryPurchase(await declaredState({
        ...state,
        characterId: 86,
        level: 40,
        adena: 100000,
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 100000 },
            93: { selfId: 93, name: 'Winged Spear', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [14], slot: 14, rank: 'd', kind: 'Weapon.Pole' }
        },
        stats: {
            classId: 55,
            role: 'dps',
            equipment: [{ selfId: 93, slot: 14, rank: 'd', kind: 'Weapon.Pole' }],
            equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 626, name: 'Bronze Shield', slot: 8 } },
            partyRequest: { status: 'open', priority: 'required' },
            marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' }
        }
    }, 'incompatible_shield'), {
        type: 'upgrade_gear',
        status: 'active',
        target: { itemId: 626, itemName: 'Bronze Shield', itemSlot: 8 },
        plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Giran' }
    });
    assert.strictEqual(incompatibleShield.reason, 'incompatible_loadout');
    assert.strictEqual(incompatibleShield.purchased, false);
    assert.strictEqual(blockedReserveCalls, 0, 'an incompatible purchase must be rejected before reserving market stock');
    assert.strictEqual(incompatibleShield.state.stats.equipmentPlan, undefined,
        'rejecting an incompatible shield must discard the stale acquisition plan');
    assert.strictEqual(incompatibleShield.state.stats.partyRequest, undefined,
        'rejecting an incompatible shield must clear its obsolete party request');
    MarketOpportunity.bestOffer = originals.bestOffer;
    MarketOpportunity.reserve = originals.reserve;

    const noOffer = await ColdMarketService.tryPurchase(await declaredState({
        ...state,
        characterId: 79,
        stats: { ...state.stats, marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' } },
        loc: { locX: 80000, locY: 150000, locZ: -3466 }
    }, 'missing_material'), { type: 'buy_craft_material', target: { itemId: 999999, itemName: 'Missing Material' } });
    assert.strictEqual(noOffer.purchased, false);
    assert.strictEqual(noOffer.state.activity, 'traveling', 'a buyer with no offer must return to farming instead of waiting in Giran');
    assert.strictEqual(noOffer.state.stats.travel.arrivalActivity, 'hunting');
    assert(noOffer.state.stats.marketRetryAfter > Date.now(), 'a buyer with no offer must wait before retrying the same market trip');

    MarketOpportunity.bestOffer = () => null;
    BuyStoreService.open = () => Promise.reject(new Error('forced buy-store persistence failure'));
    const failedBuyStore = await ColdMarketService.tryPurchase(await declaredState({
        ...state,
        characterId: 82,
        stats: { ...state.stats, marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' } }
    }, 'failed_buy_store'), { type: 'buy_craft_material', target: { itemId: 999999, itemName: 'Missing Material' } });
    assert.strictEqual(failedBuyStore.reason, 'no_affordable_offer', 'a rejected WTB open must enter the normal market retry path');
    assert(failedBuyStore.state.stats.marketRetryAfter > Date.now());
    BuyStoreService.open = originals.openBuyStore;

    MarketOpportunity.bestOffer = () => ({ selfId: 2, price: 1000, sourceType: 'cold_store', storeItem: { count: 1, price: 1000 } });
    MarketOpportunity.reserve = () => false;
    const changedOffer = await ColdMarketService.tryPurchase(await declaredState({
        ...state,
        characterId: 80,
        stats: { ...state.stats, marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' } },
        loc: { locX: 80000, locY: 150000, locZ: -3466 }
    }, 'changed_offer'), { type: 'buy_craft_material', target: { itemId: 2, itemName: 'Changed Offer' } });
    assert.strictEqual(changedOffer.reason, 'offer_changed');
    assert.strictEqual(changedOffer.state.activity, 'traveling', 'a stale offer must return the buyer to farming');
    assert(changedOffer.state.stats.marketRetryAfter > Date.now(), 'a stale offer must also start the retry cooldown');

    const duplicateArmorPurchase = await BotLifeState.applyMarketPurchase({
        ...state,
        characterId: 83,
        adena: 1010000,
        inventory: { ...state.inventory, 57: { selfId: 57, name: 'Adena', amount: 1010000 } }
    }, { selfId: 354, price: 505000, sourceType: 'cold_store' }, 2);
    assert.strictEqual(duplicateArmorPurchase, null, 'slotted non-stackable equipment must never be stored as one inventory row with quantity greater than one');

    const repeatedArmorPurchase = await BotLifeState.applyMarketPurchase({
        ...state,
        characterId: 87,
        adena: 505000,
        inventory: {
            ...state.inventory,
            57: { selfId: 57, name: 'Adena', amount: 505000 },
            354: { selfId: 354, name: 'Mithril Tunic', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [10], slot: 10 }
        }
    }, { selfId: 354, price: 505000, sourceType: 'cold_store' });
    assert.strictEqual(repeatedArmorPurchase, null,
        'sequential one-item purchases must not bypass the non-stackable equipment capacity');

    assert.strictEqual(BotLifeState.marketPurchaseBlocker({
        inventory: {
            93: { selfId: 93, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [14], slot: 14, kind: 'Weapon.Pole' }
        }
    }, { selfId: 626 }, 1), 'incompatible_loadout',
    'the transaction preflight must reject a shield while a two-handed weapon is equipped');

    const dEarring = DataCache.items.find((item) => String(item.etc?.rank).toLowerCase() === 'd'
        && item.template?.kind === 'Armor.Jewel' && Number(item.etc?.slot) === 1);
    const pairedPurchase = await BotLifeState.applyMarketPurchase(await declaredState({
        ...state,
        characterId: 85,
        level: 20,
        adena: 1000,
        inventory: { ...state.inventory, 57: { selfId: 57, name: 'Adena', amount: 1000 } }
    }, 'paired_earrings'), { selfId: dEarring.selfId, price: 100, sourceType: 'npc', equipSlot: 1 }, 2);
    assert(pairedPurchase, 'paired non-stackable jewellery must support buying two physical copies');
    assert.strictEqual(pairedPurchase.inventory[String(dEarring.selfId)].amount, 2);
    assert.strictEqual(pairedPurchase.inventory[String(dEarring.selfId)].equippedCount, 2);
    assert.deepStrictEqual(pairedPurchase.inventory[String(dEarring.selfId)].equippedSlots, [1, 2]);
    const pairedPhysical = await Database.fetchItems(85);
    assert.strictEqual(Native.amount(pairedPhysical, 57), 800);
    assert.strictEqual(Native.amount(pairedPhysical, Number(dEarring.selfId)), 2);
    assert.deepStrictEqual(pairedPhysical.filter(row => Number(row.selfId) === Number(dEarring.selfId)).map(row => Number(row.slot)).sort((a,b) => a-b), [1,2]);
    assert.deepStrictEqual(
        pairedPurchase.stats.equipment.filter((item) => Number(item.selfId) === Number(dEarring.selfId)).map((item) => item.slot),
        [1, 2],
        'cold equipment summary must retain both identical earring instances'
    );

    const secondEarringPurchase = await BotLifeState.applyMarketPurchase(await declaredState({
        ...state,
        characterId: 86,
        level: 20,
        adena: 1000,
        inventory: {
            ...state.inventory,
            57: { selfId: 57, name: 'Adena', amount: 1000 },
            [dEarring.selfId]: {
                selfId: dEarring.selfId,
                name: dEarring.template.name,
                amount: 1,
                equipped: true,
                equippedCount: 1,
                equippedSlots: [1],
                slot: 1,
                rank: dEarring.etc.rank,
                kind: dEarring.template.kind
            }
        }
    }, 'second_earring'), { selfId: dEarring.selfId, price: 100, sourceType: 'npc', equipSlot: 2 });
    assert(secondEarringPurchase, 'a single equipped earring must allow buying its paired copy');
    assert.strictEqual(secondEarringPurchase.inventory[String(dEarring.selfId)].amount, 2);
    assert.deepStrictEqual(secondEarringPurchase.inventory[String(dEarring.selfId)].equippedSlots, [1, 2]);
    const secondPhysical = await Database.fetchItems(86);
    assert.strictEqual(Native.amount(secondPhysical, 57), 900);
    assert.strictEqual(Native.amount(secondPhysical, Number(dEarring.selfId)), 2);

    const workingInventorySync = Database.syncInventorySummary;
    let rejectFirstPurchaseSync = true;
    let advancedBeforeRejectedSync;
    Database.syncInventorySummary = async (characterId, inventory, ...args) => {
        calls.push({ type: 'inventory-sync', characterId, inventory });
        if (Number(characterId) === 84 && rejectFirstPurchaseSync) {
            rejectFirstPurchaseSync = false;
            const [row] = await Database.execute(['SELECT adena, inventorySummary, statsJson FROM bot_life_state WHERE characterId = ?', [84]]);
            const savedBag = JSON.parse(row.inventorySummary), physical = await Database.fetchItems(84);
            assert.strictEqual(Number(row.adena), 0, 'life-row save precedes the failed item sync');
            assert.strictEqual(savedBag['2'].amount, 1);
            assert.strictEqual(savedBag['2'].equipped, true);
            assert.strictEqual(Native.amount(physical, 57), 1000, 'the rejected first sync leaves the physical wallet untouched');
            assert.strictEqual(Native.amount(physical, 2), 0);
            assert.strictEqual(Number(physical.find(item => Number(item.selfId) === 1).equipped), 1);
            advancedBeforeRejectedSync = { wallet: Number(row.adena), bag: savedBag, stats: JSON.parse(row.statsJson) };
            throw new Error('forced inventory sync failure');
        }
        return originals.syncInventorySummary.call(Database, characterId, inventory, ...args);
    };
    const partiallyPersisted = await BotLifeState.applyMarketPurchase(await declaredState({
        ...state,
        characterId: 84
    }, 'partial_before_sync'), { selfId: 2, price: 1000, sourceType: 'cold_store' });
    assert.strictEqual(partiallyPersisted, null);
    const compensationSyncs = calls.filter((call) => call.type === 'inventory-sync' && call.characterId === 84);
    assert.strictEqual(compensationSyncs.length, 2, 'a partial purchase write must immediately restore the original inventory snapshot');
    assert.strictEqual(compensationSyncs[1].inventory['57'].amount, 1000);
    assert.strictEqual(compensationSyncs[1].inventory['2'], undefined);
    assert(advancedBeforeRejectedSync, 'observe the meaningful pre-compensation durable advance');
    assert.strictEqual(advancedBeforeRejectedSync.stats.lastMarketPurchase.totalPrice, 1000);
    const [restoredRow] = await Database.execute(['SELECT adena, inventorySummary, statsJson FROM bot_life_state WHERE characterId = ?', [84]]);
    const restoredBag = JSON.parse(restoredRow.inventorySummary), restoredStats = JSON.parse(restoredRow.statsJson);
    assert.strictEqual(Number(restoredRow.adena), 1000);
    assert.strictEqual(restoredBag['2'], undefined);
    assert.strictEqual(restoredBag['1'].equipped, true);
    assert.strictEqual(restoredStats.equipmentPlan.target.selfId, 2);
    assert.strictEqual(restoredStats.lastMarketPurchase, undefined);
    const restoredPhysical = await Database.fetchItems(84);
    assert.strictEqual(Native.amount(restoredPhysical, 57), 1000);
    assert.strictEqual(Native.amount(restoredPhysical, 2), 0);
    assert.strictEqual(Number(restoredPhysical.find(item => Number(item.selfId) === 1).equipped), 1);
    console.log('Native partial compensation:', JSON.stringify({ advancedWallet: advancedBeforeRejectedSync.wallet,
        restoredWallet: Number(restoredRow.adena), physicalWallet: Native.amount(restoredPhysical, 57),
        restoredSword: Native.amount(restoredPhysical, 1), acquiredSword: Native.amount(restoredPhysical, 2), actualSyncCalls: compensationSyncs.length }));
    Database.syncInventorySummary = workingInventorySync;

    const armorPurchase = await BotLifeState.applyMarketPurchase(await declaredState({
        ...state,
        characterId: 78,
        adena: 505000,
        inventory: {
            ...state.inventory,
            57: { selfId: 57, name: 'Adena', amount: 505000 },
            21: { selfId: 21, name: 'Shirt', amount: 1, equipped: true, slot: 10, rank: 'none', kind: 'Armor.Light' }
        },
        stats: {
            equipment: [
                { selfId: 1, slot: 7, rank: 'none', kind: 'Weapon.Sword' },
                { selfId: 21, slot: 10, rank: 'none', kind: 'Armor.Light' }
            ]
        }
    }, 'armor'), { selfId: 354, price: 505000, sourceType: 'npc' });
    assert.strictEqual(armorPurchase.inventory['1'].equipped, true, 'a chest purchase must keep the weapon equipped');
    assert.strictEqual(armorPurchase.inventory['21'].equipped, false);
    assert.strictEqual(armorPurchase.inventory['354'].equipped, true);
    assert(armorPurchase.stats.equipment.some((item) => item.selfId === 1 && item.slot === 7));
    assert(armorPurchase.stats.equipment.some((item) => item.selfId === 354 && item.slot === 10));
    const armorSync = calls.find((call) => call.type === 'inventory-sync' && call.characterId === 78);
    assert.strictEqual(armorSync.inventory['21'].equipped, false, 'the optimized sync must persist the unequipped old chest');
    assert.strictEqual(armorSync.inventory['354'].equipped, true, 'the optimized sync must persist the new chest');

    const materialPurchase = await BotLifeState.applyMarketPurchase(await declaredState({
        ...state,
        characterId: 81,
        adena: 900,
        inventory: {
            ...state.inventory,
            57: { selfId: 57, name: 'Adena', amount: 900 }
        }
    }, 'material'), { selfId: 1864, price: 100, sourceType: 'cold_store' }, 3);
    assert(materialPurchase, 'craft materials must be purchasable through the market path');
    const materialPhysical = await Database.fetchItems(81);
    assert.strictEqual(Native.amount(materialPhysical, 57), 600);
    assert.strictEqual(Native.amount(materialPhysical, 1864), 3);
    assert.strictEqual(materialPurchase.adena, 600);
    assert.strictEqual(materialPurchase.inventory['1864'].amount, 3);
    assert.strictEqual(materialPurchase.inventory['1864'].equipped, false);
    assert.strictEqual(materialPurchase.inventory['1'].equipped, true, 'material purchase must not disturb equipped gear');

    const starterInventory = BotLifeState.inventorySummaryFromItems(
        BotGear.planFor({ classId: 31, level: 1 }).items
    );
    let progressing = {
        ...state,
        characterId: 91,
        level: 19,
        adena: 1000000,
        inventory: { ...starterInventory, 57: { selfId: 57, amount: 1000000 } },
        stats: { classId: 31, role: 'dps', equipment: BotLifeState.equipmentSummaryFromInventory(starterInventory) }
    };
    await NativeChoice.capture(progressing, {}, 'cold_purchase_progression_original');
    // Original pure planner unit seam (missing-packet fallback), followed by
    // raw native execution; it does not represent a shared worker wish roll.
    progressing = await declaredState(progressing, 'progressing_original');
    const initialWeaponPlan = GearAcquisitionPlanner.planFor(progressing);
    assert.strictEqual(initialWeaponPlan.target.slot, 7, 'the starter weapon still gets its first upgrade');
    progressing.stats.equipmentPlan = initialWeaponPlan;
    progressing = await BotLifeState.applyMarketPurchase(progressing, {
        selfId: initialWeaponPlan.target.selfId,
        price: initialWeaponPlan.market.price,
        sourceType: 'npc'
    });
    assert(progressing?.inventory[initialWeaponPlan.target.selfId]?.equipped);
    // A fresh state without purchase history must make the same decision.
    delete progressing.stats.lastMarketPurchase;
    const protectionPlan = GearAcquisitionPlanner.planFor(JSON.parse(JSON.stringify(progressing)));
    assert([6, 9, 10, 11, 12, 15].includes(protectionPlan.target.slot),
        'after the first weapon improvement, lagging basic armour must beat another weapon purchase');
    progressing.stats.equipmentPlan = protectionPlan;
    const protectedState = await BotLifeState.applyMarketPurchase(progressing, {
        selfId: protectionPlan.target.selfId,
        price: protectionPlan.market.price,
        sourceType: 'npc'
    });
    assert(protectedState?.inventory[protectionPlan.target.selfId]?.equipped,
        'the protection selected by the planner must actually be equipped after purchase');
    assert(protectedState.inventory[initialWeaponPlan.target.selfId].equipped);
    const protectedSync = calls.filter((call) => call.type === 'inventory-sync' && call.characterId === 91).at(-1);
    assert(protectedSync.inventory[protectionPlan.target.selfId].equipped,
        'the native purchase must persist the newly selected protection');

    const palusState = {
        ...state,
        characterId: 92,
        level: 25,
        adena: 300000,
        inventory: { ...starterInventory, 57: { selfId: 57, amount: 300000 } },
        stats: { classId: 32, role: 'tank', equipment: BotLifeState.equipmentSummaryFromInventory(starterInventory) }
    };
    await NativeChoice.capture(palusState, {}, 'cold_purchase_palus_original');
    await declaredState(palusState, 'palus_original');
    const palusPlan = GearAcquisitionPlanner.planFor(palusState);
    assert.strictEqual(palusPlan.target.selfId, 347);
    palusState.stats.equipmentPlan = palusPlan;
    const palusPurchase = await BotLifeState.applyMarketPurchase(palusState, {
        selfId: palusPlan.target.selfId, price: palusPlan.market.price, sourceType: 'npc'
    });
    assert(palusPurchase?.inventory[347]?.equipped, 'the affordable D chest must be bought and equipped');
    assert.strictEqual(palusPurchase.inventory[21].equipped, false, 'the starting Shirt must be replaced');
    assert.strictEqual(palusPurchase.adena, 300000 - palusPlan.market.price);
    assert(palusPurchase.adena >= palusPlan.market.reserve, 'the purchase must retain the operating reserve');

    assert.deepStrictEqual(Economy.summary().mainColdForState, {}, 'all consumption avoids a main cold wish build');
    console.log('Bot cold market purchase checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(async () => {
    Database.reconcileBotClanMembership = originals.reconcileBotClanMembership;
    Database.reconcileBotClanGoals = originalReconcileClanGoals;
    Database.execute = originals.execute;
    Database.fetchItems = originals.fetchItems;
    Database.updateItemAmount = originals.updateItemAmount;
    Database.updateItemEquipState = originals.updateItemEquipState;
    Database.setItem = originals.setItem;
    Database.syncInventorySummary = originals.syncInventorySummary;
    Database.updateCharacterLocation = originals.updateCharacterLocation;
    Database.updateCharacterExperience = originals.updateCharacterExperience;
    Database.updateCharacterVitals = originals.updateCharacterVitals;
    GoalState.clear = originals.clearGoal;
    World.user = originals.user;
    MarketOpportunity.bestOffer = originals.bestOffer;
    MarketOpportunity.reserve = originals.reserve;
    BuyStoreService.open = originals.openBuyStore;
    Economy.forState = originalFullEconomy;
    MarketTelemetry.reset();
    try { await Afk._resetForTests(); } finally { await Database.close(); }
});
