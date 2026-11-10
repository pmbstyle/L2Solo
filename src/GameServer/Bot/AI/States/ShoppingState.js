const refreshPartyMemberships = require('../../../World/PartyMembershipPublication');
const { raiseDecision, held, replaceStats, statsFor } = require('../DecisionEvents');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const SpeckMath      = invoke('GameServer/SpeckMath');
const ServerResponse = invoke('GameServer/Network/Response');
const TradeService   = invoke('GameServer/Bot/TradeService');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const BotTownTravel  = invoke('GameServer/Bot/AI/BotTownTravel');
const BotWarehouse   = invoke('GameServer/Bot/Economy/BotWarehouseService');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const LifeState      = invoke('GameServer/Bot/Population/BotLifeState');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const WorkflowTelemetry = invoke('GameServer/Bot/AI/BotWorkflowTelemetry');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const CompanionEquipmentShopping = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const HotTownRebuff = invoke('GameServer/Bot/AI/HotTownRebuff');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const TradeMeetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const AfkTradeService = invoke('GameServer/AfkTrade/AfkTradeService');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const World = invoke('GameServer/World/World');
const TownTransitPolicy = invoke('GameServer/Bot/AI/TownTransitPolicy');
const InventoryCleanup = require('../CompanionInventoryCleanup');

const MAX_RESTOCK_ATTEMPTS = 3;

// The store a shopping target stands for: its stall's, or a board record's
// (an ad has no stall: it is dealt with by record, MarketOpportunity.offerTarget).
function targetStore(target) {
    if (target?.recordId) return { store: AfkTradeService.recordStore(target.recordId), name: target.name };
    const actor = findStoreSession(target?.actorId)?.actor;
    return { store: actor?.fetchPrivateStore?.() || null, name: actor?.fetchName?.() || target?.name, actor };
}

function findStoreSession(actorId) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    return BotManager.findSessionById(actorId)
        || (World.user?.sessions || []).find((session) => session.actor?.fetchId?.() === actorId)
        || AfkTradeService.findProjection(actorId)?.session
        || null;
}

// sale: selfId -> units, what the bot decided to sell into this record
// (TradeService.findAfkBuyerForActor); without it, every line it can fill.
async function sellInventoryToAfk(bot, store, coldState = null, sale = null) {
    const sold = [];
    let state = coldState;
    const left = sale ? new Map(Object.entries(sale).map(([selfId, units]) => [Number(selfId), Number(units)])) : null;
    const candidates = TradeService.sellableActorItems(bot, coldState).map((item) => ({
        objectId: Number(item.fetchId?.()),
        selfId: Number(item.fetchSelfId?.()),
        amount: Number(item.fetchAmount?.())
    })).filter((item) => item.amount > 0);
    for (const item of candidates) {
        const currentStore = AfkTradeService.recordStore(store?.shopId) || store;
        const line = currentStore.items?.find((entry) => Number(entry.selfId) === item.selfId && Number(entry.count) > 0);
        if (!line) continue;
        const qty = Math.min(item.amount, Number(line.count), left ? Number(left.get(item.selfId) || 0) : Infinity);
        if (qty <= 0) continue;
        if (left) left.set(item.selfId, left.get(item.selfId) - qty);
        const result = await AfkTradeService.sellToShop(
            bot.fetchId(), currentStore, item.selfId, qty,
            { objectId: item.objectId, expectedPrice: line.price, coldState: state }
        );
        if (result.pending) return { ...result, coldState: result.state || state,
            pendingSale: { qty, name: line.name || item.selfId, totalAdena: qty * line.price },
            itemsSold: sold.reduce((sum, line) => sum + line.qty, 0), totalAdena: sold.reduce((sum, line) => sum + line.totalAdena, 0), sold };
        state = result.coldState || state;
        sold.push({ qty, name: line.name || item.selfId, totalAdena: result.totalPrice });
    }
    return {
        itemsSold: sold.reduce((sum, line) => sum + line.qty, 0),
        totalAdena: sold.reduce((sum, line) => sum + line.totalAdena, 0),
        sold,
        coldState: state
    };
}

function formatAdena(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// A cold bot's review withdraws a buy order once its target is owned
// ("an owned gear target must not reopen a persistent buy order"), but a hot
// bot is not reviewed: an order left open after the bot bought the item in
// town could still fill and deliver a second copy.
async function withdrawBuyOrderFor(bot, selfId) {
    const ordered = AfkTradeService.ownerRecords(bot.fetchId()).some((record) => Number(record.storeType) === AfkTradeService.BUY
        && (record.lines || []).some((line) => Number(line.selfId) === Number(selfId) && Number(line.count) > 0));
    if (!ordered) return;
    try {
        // Before the new item is equipped: the withdrawal reloads the backpack
        // from the database to return the escrow.
        await invoke('GameServer/Bot/Economy/BotAfkMarketService').withdrawBuyAds(bot.fetchId(), selfId);
    } catch (error) {
        utils.infoWarn('Shopping', 'buy order withdrawal failed for %s: %s', bot.fetchName(), error.message);
    }
}

// The step's own root bids pay it when the bag alone cannot (the errand's bids, the
// decision's): taken back before the body pays (BotAfkMarketService.freeStepBids).
async function freeStepBids(bot, errand) {
    await invoke('GameServer/Bot/Economy/BotAfkMarketService').freeStepBids(bot.fetchId(), errand.bids,
        Number(errand.price) * Number(errand.amount || 1), Number(bot.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0));
}

function clearCompletedMarketPlan(session, bot, purchase) {
    const state = session.coldLifeState;
    if (!state) return;

    const equipmentPlan = state.stats?.equipmentPlan;
    const combineResultId = Number(equipmentPlan?.combine?.resultId || 0);
    const componentPurchase = combineResultId > 0
        && Number(equipmentPlan?.target?.selfId || 0) !== combineResultId;
    const stats = { ...(state.stats || {}) };
    const crystalInput = invoke('GameServer/Bot/Economy/BotCrystallization').inputAmount(state, purchase.selfId);
    if (!componentPurchase && !crystalInput) delete stats.equipmentPlan;
    session.coldLifeState = {
        ...state,
        adena: Number(bot.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || state.adena || 0),
        inventory: LifeState.inventorySummaryFromItems(bot.backpack?.fetchItems?.() || []),
        stats: {
            ...stats,
            lastMarketPurchase: {
                selfId: Number(purchase.selfId),
                price: Number(purchase.price),
                sourceType: purchase.sourceType || 'private_store',
                sourceId: Number(purchase.sourceId ?? purchase.sellerId),
                at: Date.now()
            }
        }
    };
    refreshPartyMemberships([session], invoke);
}

function continueEquipmentShopping(session, bot, BotAI, errand) {
    const town = BotAI.getClosestTown?.(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ()) || {
        name: errand.target?.town,
        x: errand.target?.locX,
        y: errand.target?.locY,
        z: errand.target?.locZ
    };
    const excludedSlots = [...new Set([
        ...(errand.excludedSlots || []).map(Number),
        ...((session.coldLifeState?.stats?.equipmentPlan?.combine
            && session.coldLifeState.stats.equipmentPlan.status !== 'complete') ? [] : [Number(errand.slot || 0)])
    ].filter(Boolean))];
    const next = CompanionEquipmentShopping.planErrand(
        session,
        bot,
        town,
        Number(errand.purchaseCount || 0) + 1,
        excludedSlots
    );
    if (!next || next.pending) return false;

    session.companionShopping = next;
    session.shoppingTarget = next.target;
    session.shoppingDoneAnnounced = false;
    CompanionNavigationRecovery.clear(session);
    return true;
}

function townMerchantTarget(town, bot, selfId = 0, options = {}) {
    const from = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    const role = TownServiceCatalog.ROLES.GENERIC_MERCHANT;
    return TownServiceCatalog.targetFor(role, town.name, {
        selfId,
        from,
        excludedNpcSelfIds: options.excludedNpcSelfIds || []
    }) || TownServiceCatalog.targetNear(role, from, {
        selfId,
        maxDistance: Infinity,
        excludedNpcSelfIds: options.excludedNpcSelfIds || []
    });
}

function alternateTownNpcErrand(session, bot, town) {
    const errand = session.companionShopping;
    if (!town?.name || !['sell_resources', 'sell_junk', 'restock_shots', 'sell_unused_arrows'].includes(errand?.kind)) return null;
    const failedSourceIds = new Set((errand.failedSourceIds || []).map(Number));
    const failedNpcSelfId = Number(session.shoppingTarget?.npcSelfId || 0);
    if (failedNpcSelfId) failedSourceIds.add(failedNpcSelfId);
    const selfId = errand.kind === 'restock_shots'
        ? Number(ShotStock.planForActor(bot)?.selfId || 0)
        : 0;
    if (selfId) {
        if (session.shoppingTarget?.actorId) failedSourceIds.add(Number(
            session.shoppingTarget.sourceId || session.shoppingTarget.actorId));
        const target = ShotStock.restockTarget(bot, town.name, [...failedSourceIds], heldShoppingKit(session, town.name));
        return target ? { ...errand, failedSourceIds: [...failedSourceIds], target } : null;
    }
    const target = townMerchantTarget(town, bot, selfId, {
        excludedNpcSelfIds: [...failedSourceIds]
    });
    if (!target) return null;
    return {
        ...errand,
        failedSourceIds: [...failedSourceIds],
        target
    };
}

// A gear errand that failed where the body acts: its step failed (goal_failed, the
// held step dropped) and the errand's key is marked (GearMarks: no gear plan or errand
// takes it again until its source changed).
function deferEquipmentRetry(session) {
    if (!['npc_equipment_purchase', 'market_purchase', 'dual_component_withdrawal', 'dual_sword_combine', 'mammon_unseal'].includes(session.companionShopping?.kind)) return;
    raiseDecision(session, 'goal_failed', { impossible: true,
        payload: { kind: 'gear_errand', key: require('../GearMarks').errandKey(session.companionShopping) } });
}

// A purchase refused for money (the purse short of the step), counted as a cold buyer's
// funding_short. Its errand is marked as a cold buyer's funding_short is, temporary: until
// the wish network admits a shop step only at the terms its buyer pays.
const FUNDING_REFUSALS = new Set(['Not enough Adena.', 'not_enough_adena', 'insufficient_adena', 'economy_funding_changed', 'npc_line_not_funded']);

// A refused gear purchase names its cause: the bot only says it could not buy.
function equipmentPurchaseFailed(session, bot, errand, error) {
    if (FUNDING_REFUSALS.has(error?.message)) invoke('GameServer/Bot/Economy/MarketTelemetry').fundingShort();
    deferEquipmentRetry(session);
    session.lastTradeSummary = `could not buy ${errand.itemName || errand.itemId}`;
    utils.infoWarn('Shopping', '%s could not buy %s (%s): %s', bot.fetchName(), errand.itemId, errand.kind, error?.message || error);
}

function usesWarehouseStop(session) {
    const kind = session.companionShopping?.kind;
    return !kind || kind === 'sell_resources' || kind === 'sell_junk';
}

function warehouseTarget(town, bot, options = {}) {
    const from = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    return TownServiceCatalog.targetFor(TownServiceCatalog.ROLES.WAREHOUSE, town?.name, {
        from,
        excludedNpcSelfIds: options.excludedNpcSelfIds || []
    }) || TownServiceCatalog.targetNear(TownServiceCatalog.ROLES.WAREHOUSE, from, {
        maxDistance: Infinity,
        excludedNpcSelfIds: options.excludedNpcSelfIds || []
    });
}

function restoreAfterWarehouse(session) {
    session.shoppingServicePhase = 'merchant';
    session.shoppingTarget = session.shoppingAfterWarehouseTarget;
    session.shoppingAfterWarehouseTarget = undefined;
    session.shoppingDoneAnnounced = false;
    session.failedWarehouseNpcSelfIds = undefined;
}

// What this town visit sells to the NPC, once per visit: the warehouse stop
// leaves it in the bag for that sale, as the cold visit sells before it stores.
function shoppingNpcSale(session) {
    if (!session.shoppingNpcSale) session.shoppingNpcSale = MarketListingPolicy.npcSaleForActor(session);
    return session.shoppingNpcSale;
}

function clearShoppingServiceState(session) {
    session.pendingShoppingMeeting?.controller.abort();
    TownNpcApproach.reset(session);
    CompanionNavigationRecovery.clear(session);
    session.shoppingNpcSale = undefined;
    session.shoppingServicePhase = undefined;
    session.shoppingWarehouseDone = undefined;
    session.shoppingAfterWarehouseTarget = undefined;
    session.failedWarehouseNpcSelfIds = undefined;
    session.shoppingEquipmentPlanChecked = undefined;
    session.shoppingLiveShotStopChecked = undefined;
    session.shoppingLiveBuyerChecked = undefined;
    session.shoppingRestockFailures = undefined;
    session.shopDeparture = undefined;
    session.shoppingKit = undefined;
    session.shoppingSale = undefined;
}

// The visit's kit amounts, fixed at its first restock once its sale has
// settled (shoppingSale): the build's kit rates over the bag and wallet then,
// at that town's quotes (EconomyContext.keptKit), read by every restock of the
// visit in that town. None without a town. The same kit rule cold execution
// reads on main; picked once per stop, so the body keeps it rather than wait
// for a worker plan of the visit.
function shoppingKit(session, bot, town) {
    if (!town) return undefined;
    if (session.shoppingKit?.town !== town) {
        const NpcRestock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
        session.shoppingKit = { town, kit: EconomyContext.keptKit(EconomyContext.stateForActor(bot, session), {},
            { quote: id => NpcRestock.quoteFor(id, town)?.price }) };
    }
    return session.shoppingKit.kit;
}
// The visit's kit when it was fixed in this town, else none (a read never fixes it).
const heldShoppingKit = (session, town) => session.shoppingKit?.town === town ? session.shoppingKit.kit : undefined;
// The visit's NPC sale of its junk (SellJunk), kept so the restock fixes its kit after the sale's Adena arrived.
function sellJunk(session) {
    session.activeMultiSell = null;
    session.shoppingSale = invoke(path.world + 'NpcBypasses/SellJunk')(session);
}

async function waitForShoppingMeeting(session, bot, pending, visit) {
    const current = () => session.actor === bot && session.plan === 'shopping' && !bot.isDead?.()
        && session.companionShopping === visit.errand && session.shoppingTarget === visit.target
        && session.shopTimer === visit.shopTimer;
    if (!current()) return { interrupted: true };
    session.pendingShoppingMeeting?.controller.abort();
    const marker = { controller: new AbortController() };
    session.pendingShoppingMeeting = marker;
    try {
        const receipt = await TradeMeetings.waitForResult(
            pending.token || pending.preparationId, bot.fetchId(), { signal: marker.controller.signal });
        if (!current() || marker.controller.signal.aborted) return { interrupted: true };
        const state = LifeState.cachedState(bot.fetchId());
        if (state) {
            session.coldLifeState = state;
            refreshPartyMemberships([session], invoke);
        }
        return receipt || { outcome: 'cancelled' };
    } catch (error) {
        if (!current() || marker.controller.signal.aborted) return { interrupted: true };
        throw error;
    } finally {
        if (session.pendingShoppingMeeting === marker) session.pendingShoppingMeeting = undefined;
    }
}

function prepareEquipmentMarketStop(session, bot, town, BotAI, economy) {
    const plan = session.coldLifeState?.stats?.equipmentPlan;
    if (session.companionShopping || session.shoppingTarget || session.shoppingEquipmentPlanChecked) return false;
    if (!town?.name) return false;
    const unseal = invoke('GameServer/Bot/AI/BotMammonUnseal').plan(session,bot,town,{
        ...session.coldLifeState,stats:{...session.coldLifeState?.stats,classId:bot.fetchClassId()}
    });
    if (!unseal && session.partyCompanion === true
        && (plan?.strategy !== 'market' || Number(plan.target?.selfId || 0) <= 0)) return false;

    // One indexed lookup per town visit is enough. If the offer disappears,
    // the normal purchase failure cooldown handles the next attempt.
    const errand = unseal || CompanionEquipmentShopping.planErrand(session, bot, town, 0, [], economy);
    if (errand?.pending) return true;
    session.shoppingEquipmentPlanChecked = true;
    if (!errand) return false;
    session.companionShopping = errand;
    session.shoppingTarget = errand.target;
    session.shoppingDoneAnnounced = false;
    CompanionNavigationRecovery.clear(session);
    TownChatter.say(session, BotAI, 'equipment-market-selected', Speech.lines('town.equipment-market-selected', { item: errand.itemName, seller: errand.target.name }));
    return true;
}

function prepareWarehouseStop(session, bot, town, BotAI) {
    if (session.shoppingTarget?.liveBuyer) return false;
    if (session.shoppingServicePhase === 'warehouse') return true;
    if (session.shoppingWarehouseDone || !usesWarehouseStop(session)) return false;
    if (!BotWarehouse.hasActorWithdrawalCandidates(bot, session.coldLifeState)
        && !BotWarehouse.hasActorDepositCandidates(bot, session.coldLifeState, shoppingNpcSale(session))) {
        session.shoppingWarehouseDone = true;
        return false;
    }

    const target = warehouseTarget(town, bot);
    if (!target) {
        session.shoppingWarehouseDone = 'unavailable';
        TownChatter.say(session, BotAI, 'warehouse-not-in-town', Speech.lines('town.warehouse-not-in-town'), { priority: 'coordination' });
        return false;
    }

    session.shoppingAfterWarehouseTarget = session.shoppingTarget;
    session.shoppingTarget = target;
    session.shoppingServicePhase = 'warehouse';
    session.shoppingDoneAnnounced = false;
    CompanionNavigationRecovery.clear(session);
    TownNpcApproach.reset(session);
    TownChatter.say(session, BotAI, 'warehouse-selected', Speech.lines('town.warehouse-selected', { merchant: target.name }));
    return true;
}

// The visible executor uses the same selected workshop, material quantities,
// native funding and durable attempt receipt as the distant customer.
function workshopTarget(session, bot, selectedPlan = null) {
    const physical = LifeState.cachedState(bot.fetchId()) || session.coldLifeState;
    const plan = selectedPlan || session.coldLifeState?.stats?.equipmentPlan || physical?.stats?.equipmentPlan;
    if (plan?.strategy !== 'craft' || !['active', 'component_ready', 'ready_to_craft'].includes(plan.status)) return null;
    const saved = physical && { ...physical, stats: { ...physical.stats, equipmentPlan: plan } };
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const state = { ...saved, inventory: LifeState.inventorySummaryFromItems(bot.backpack.fetchItems()) };
    const finalRecipe = Recipes.resolveByRecipeId(plan.recipeId);
    const recipe = ColdCraftingService.readyRecipeFor(state, finalRecipe);
    const station = recipe && ColdCraftingService.stationForRecipe(recipe.recipeId, state);
    if (!station?.workshop) return null;
    return { workshop: true, name: 'workshop', town: station.townName,
        ...(station.playerWorkshop ? { actorId: station.characterId, interactionDistance: 150 } : {}),
        locX: station.loc.locX, locY: station.loc.locY, locZ: station.loc.locZ,
        state, recipe, finalRecipe, station };
}
// A hot stock craft order: the stock plan the worker attached to the held
// decision (DecisionEvents.nearFields, personalCraftPlan with allowStock).
function stockWorkshopTarget(session, bot, decision = held(session)) {
    const plan = decision?.personalCraft;
    if (plan?.purpose !== 'stock' || !/^stock:(shots|potions|scrolls)$/.test(String(decision.network?.activity?.rootKey))) return null;
    return workshopTarget(session, bot, plan);
}
async function craftAtWorkshop(session, bot, target) {
    if (session.workshopCrafting) return;
    session.workshopCrafting = true;
    const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    try {
        const { recipe, finalRecipe, station, state } = target;
        let batches = Math.min(64, ColdCraftingService
            .requiredCraftCount(finalRecipe, recipe, state));
        if (state.stats.equipmentPlan.purpose === 'stock') {
            const items = bot.backpack.fetchItems().map(item => ({ id: item.fetchId(), selfId: item.fetchSelfId(),
                amount: item.fetchAmount(), equipped: item.fetchEquipped() }));
            batches = ColdCraftingService.craftableBatchCount(items, recipe, batches);
            const allowance = PurchaseFunding.spendable(state, 0,
                { r: state.stats.equipmentPlan.valueRate, itemId: recipe.productId });
            if (station.price > 0) batches = Math.min(batches, Math.floor(allowance / station.price));
        }
        if (!batches && !session.workshopOriginal) {
            session.shoppingTarget = undefined;
            session.shoppingServicePhase = undefined;
            session.shoppingDoneAnnounced = false;
            EconomyContext.forget(bot.fetchId());
            raiseDecision(session, 'goal_failed:visit');
            return;
        }
        const options = { batches: Math.min(batches, Math.max(1, Number(station.capacityBatches || batches)),
            station.playerWorkshop && recipe.successRate < 100 ? 1 : 64),
            expectedRevision: station.revision, expectedPrice: station.price,
            funding: { r: Number(state.stats.equipmentPlan.valueRate || 0) },
            ...(session.workshopOriginal ? { original: session.workshopOriginal } : {}) };
        let result;
        try { result = await Workshops.craft(station.characterId, recipe.recipeId, bot.fetchId(), options); }
        catch (error) {
            if (!error.economyCommand) throw error;
            session.workshopOriginal = error.economyCommand;
            result = await Workshops.craft(station.characterId, recipe.recipeId, bot.fetchId(), { original: error.economyCommand });
        }
        session.workshopOriginal = undefined;
        if (session.actor !== bot || bot.fetchIsOnline?.() === false) return;
        const items = await invoke('Database').fetchItems(bot.fetchId(), 'shopping_workshop');
        const byId = new Map(items.map(row => [Number(row.id), row]));
        const backpack = bot.backpack;
        for (const item of [...backpack.fetchItems()]) {
            const row = byId.get(Number(item.fetchId()));
            if (!row) backpack.items = backpack.fetchItems().filter(other => other !== item);
            else { item.setAmount(row.amount); byId.delete(Number(row.id)); }
        }
        for (const row of byId.values()) backpack.insertItem(row.id, row.selfId, row);
        backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
        session.coldLifeState = LifeState.cachedState(bot.fetchId()) || result.customerState;
        session.dataSendToMe?.(ServerResponse.itemsList(backpack.fetchItems()));
        EconomyContext.forget(bot.fetchId());
        session.shoppingTarget = undefined;
        session.shoppingServicePhase = undefined;
        session.shoppingDoneAnnounced = false;
        raiseDecision(session, 'goal_done:visit');
    } catch (error) {
        if (!session.workshopOriginal) {
            session.shoppingTarget = undefined;
            session.shoppingServicePhase = undefined;
            raiseDecision(session, 'goal_failed:visit', { impossible: true });
        }
        utils.infoWarn('Workshop', '%s: %s', bot.fetchName(), error.message);
    } finally { session.workshopCrafting = false; }
}

// A body's arrival in town, once a trip (BotTownTravel.request stamps its start,
// shopTimer, and whether it was forced, townTripForced): the first tick it stands in a
// town. Its shopping moment, as a far bot's (Situations.detect): on the trip its held leaf
// ordered to this town (:own, DecisionSections.leafTrip, the far rule's) the town's
// decisions wake but not the build, the visit carries out the step it came for. A visit's
// stages end with their outcome (goal_done:visit / goal_failed:visit), never another
// arrival. A player's companion follows its leader's errand: no arrival of its own.
function arrive(session, bot) {
    if (!session.shopTimer || session.townArrival === session.shopTimer || session.partyCompanion === true) return;
    const town = TownTransitPolicy.townAt(bot);
    if (!town) return;
    session.townArrival = session.shopTimer;
    const own = invoke('GameServer/Bot/Economy/DecisionSections').leafTrip(held(session)?.network?.activity, town,
        session.townTripForced === true);
    raiseDecision(session, own ? 'arrived_town:own' : 'arrived_town');
}

function shoppingMeetingPending(session, bot) {
    // The live lifecycle cache owns custody. A pre-receipt session copy
    // can still contain a meeting that has already completed/cancelled.
    const id = bot.fetchId();
    const currentLife = LifeState.cachedState(id) || session.coldLifeState;
    return TradeMeetings.hasPreparation(id) || currentLife?.stats?.tradeMeeting;
}

module.exports = {
    workshopTarget, stockWorkshopTarget, craftAtWorkshop, arrive,
    tick(session, bot, Generics, BotAI) {
        arrive(session, bot);
        // The receipt/return callback owns the rest of this visit. Rejoining
        // the counter queue during its delay steals time from real shoppers.
        if (session.shoppingDoneAnnounced) {
            TownNpcApproach.reset(session);
            return;
        }
        if (shoppingMeetingPending(session, bot)) {
            return;
        }
        invoke('GameServer/AfkTrade/TradeMeetingService').breakChanged(session, 2);
        if (session.partyCompanion === true && session.followPlayerSession && !session.companionShopping) {
            session.plan = 'following';
            session.shoppingTarget = undefined;
            session.shoppingDoneAnnounced = false;
            session.preShopLocation = undefined;
            clearShoppingServiceState(session);
            TownChatter.say(session, BotAI, 'shopping-cancelled', Speech.lines('town.shopping-cancelled'));
            return;
        }

        if (session.townEscape) {
            if (BotTownTravel.hasCombatThreat(session, bot) || !bot.state.fetchCasts()) {
                BotTownTravel.interruptEscape(session, bot);
            }
            return;
        }

        const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());

        const Improvements = invoke('GameServer/Bot/Economy/BotImprovementService');
        // The decision the body holds (DecisionEvents.held): its craft plan
        // and its improvement; the station is found here, near the body.
        const decision = held(session);
        // A stock order (purpose stock) is no equipment plan: only its
        // workshop target carries it (stockWorkshopTarget).
        const personalCraft = decision.personalCraft?.purpose === 'stock' ? null : decision.personalCraft;
        if (personalCraft && session.coldLifeState) session.coldLifeState = { ...session.coldLifeState,
            stats: { ...session.coldLifeState.stats, equipmentPlan: personalCraft } };
        const selected = ['unload_inventory', 'sell_unused_arrows'].includes(session.companionShopping?.kind) ? null : Improvements.chosen(null, decision);
        if (selected && selected.kind !== 'enchant') {
            const station = Improvements.stationTarget(bot, selected);
            if (station) { session.shoppingTarget = station; session.shoppingServicePhase = 'improvement'; }
        } else if (session.shoppingServicePhase === 'improvement') {
            session.shoppingTarget = undefined; session.shoppingServicePhase = undefined;
        }

        // ARCH-NOTE: a held workshop target is not rebuilt each tick; a stale
        // station revision fails the craft, which clears the phase and retries.
        const paidCraft = !session.companionShopping && session.shoppingServicePhase !== 'workshop'
            && (stockWorkshopTarget(session, bot, decision) || workshopTarget(session, bot));
        if (paidCraft) { session.shoppingTarget = paidCraft; session.shoppingServicePhase = 'workshop'; }
        if (session.shoppingServicePhase !== 'workshop' && prepareEquipmentMarketStop(session, bot, closestTown, BotAI, decision) && !session.companionShopping) return;
        if (!session.shoppingTarget && !session.companionShopping && !session.shoppingLiveBuyerChecked) {
            session.shoppingLiveBuyerChecked = true;
            const hasPlayerBuyer = (World.user?.sessions || []).some(viewer =>
                viewer.actor?.fetchPrivateStore?.()?.kind === 'player' && Number(viewer.actor.fetchPrivateStoreType?.()) === 3);
            const buyer = hasPlayerBuyer ? TradeService.findAfkBuyerForActor(bot, closestTown, session.coldLifeState) : null;
            const configured = buyer?.offer.sourceType === 'private_buy_store' && TradeService.findBestBuyerForActor(bot,
                // lazy: cycle BotManager loads the AI states
                invoke('GameServer/Bot/BotManager').sessions, { town: closestTown, state: session.coldLifeState });
            if (buyer?.offer.sourceType === 'private_buy_store' && (!configured || buyer.score >= configured.preview.totalAdena)) session.shoppingTarget = {
                ...MarketOpportunity.offerTarget(buyer.offer, closestTown.name), sale: buyer.sale, liveBuyer: true };
        }
        if (session.shoppingServicePhase !== 'workshop') prepareWarehouseStop(session, bot, closestTown, BotAI);

        if (!session.shoppingTarget) {
            const BotManager = invoke('GameServer/Bot/BotManager');
            const buyer = TradeService.findBestBuyerForActor(bot, BotManager.sessions, {
                town: closestTown,
                state: session.coldLifeState
            });
            const afkBuyer = TradeService.findAfkBuyerForActor(bot, closestTown, session.coldLifeState);

            if (afkBuyer && (!buyer || Number(afkBuyer.score) >= Number(buyer.preview?.totalAdena || 0))) {
                session.shoppingTarget = { ...MarketOpportunity.offerTarget(afkBuyer.offer, closestTown.name), sale: afkBuyer.sale };
                TownChatter.say(session, BotAI, 'buyer-selected', Speech.lines('town.buyer-selected', { merchant: session.shoppingTarget.name, town: session.shoppingTarget.town }));
            } else if (buyer) {
                session.shoppingTarget = {
                    actorId: buyer.actor.fetchId(),
                    name: buyer.actor.fetchName(),
                    locX: buyer.actor.fetchLocX(),
                    locY: buyer.actor.fetchLocY(),
                    locZ: buyer.actor.fetchLocZ(),
                    town: buyer.store.town || closestTown.name
                };
                TownChatter.say(session, BotAI, 'buyer-selected', Speech.lines('town.buyer-selected.player', { merchant: session.shoppingTarget.name, town: session.shoppingTarget.town }));
            } else {
                session.shoppingTarget = townMerchantTarget(closestTown, bot);
                if (!session.shoppingTarget) {
                    session.plan = 'hunting';
                    raiseDecision(session, 'goal_failed:visit', { impossible: true });
                    session.shoppingDoneAnnounced = false;
                    session.preShopLocation = undefined;
                    clearShoppingServiceState(session);
                    TownChatter.say(session, BotAI, 'npc-seller-unavailable', Speech.lines('town.npc-seller-unavailable'), { priority: 'coordination' });
                    return;
                }
                TownChatter.say(session, BotAI, 'npc-seller-selected', Speech.lines('town.npc-seller-selected', { merchant: session.shoppingTarget.name, town: session.shoppingTarget.town }));
            }
        }

        const targetActor = CompanionNavigationRecovery.resolveTargetActor(session.shoppingTarget);
        const target = CompanionNavigationRecovery.refreshTarget(session.shoppingTarget, targetActor);
        const distToTarget = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
            .distance(new SpeckMath.Point3D(target.locX, target.locY, target.locZ));
        const npcApproach = TownNpcApproach.plan(session, bot, target, 'shopping');
        if (npcApproach?.waiting) return;
        const readyToInteract = npcApproach?.ready === true
            || (!npcApproach && distToTarget <= (target.interactionDistance || 300));

        if (!readyToInteract) {
            const navigationTarget = npcApproach?.destination || target;
            const navigation = CompanionNavigationRecovery.move(session, bot, navigationTarget, 'shopping', {
                targetActor: npcApproach ? null : targetActor,
                ...(npcApproach ? { arrivalRadius: npcApproach.arrivalRadius } : {}),
                ...(target.interactionDistance ? { arrivalRadius: target.interactionDistance } : {})
            });
            if (npcApproach?.phase === 'staging' && navigation.failures > 0) {
                TownNpcApproach.skipStaging(session);
                CompanionNavigationRecovery.clear(session);
                return;
            }
            if (navigation.status === 'exhausted') {
                const town = BotAI.getClosestTown?.(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
                if (session.shoppingServicePhase === 'warehouse') {
                    const failedIds = new Set((session.failedWarehouseNpcSelfIds || []).map(Number));
                    if (target.npcSelfId) failedIds.add(Number(target.npcSelfId));
                    const alternate = warehouseTarget(town, bot, { excludedNpcSelfIds: [...failedIds] });
                    if (alternate) {
                        session.failedWarehouseNpcSelfIds = [...failedIds];
                        session.shoppingTarget = alternate;
                        TownNpcApproach.reset(session);
                        CompanionNavigationRecovery.clear(session);
                        TownChatter.say(session, BotAI, 'alternate-warehouse', Speech.lines('town.alternate-warehouse', { merchant: target.name, alternate: alternate.name }), { priority: 'coordination' });
                        return;
                    }

                    session.shoppingWarehouseDone = 'unreachable';
                    if (session.companionShopping?.kind === 'unload_inventory') {
                        this.finishInventoryUnload(session, bot, BotAI, true);
                        return;
                    }
                    restoreAfterWarehouse(session);
                    TownNpcApproach.reset(session);
                    CompanionNavigationRecovery.clear(session);
                    TownChatter.say(session, BotAI, 'warehouse-unreachable', Speech.lines('town.warehouse-unreachable'), { priority: 'coordination' });
                    return;
                }

                if (session.partyCompanion === true && session.companionShopping?.kind === 'npc_equipment_purchase') {
                    const alternate = CompanionEquipmentShopping.alternateNpcErrand(
                        session,
                        bot,
                        town,
                        session.companionShopping
                    );
                    if (alternate) {
                        session.companionShopping = alternate;
                        session.shoppingTarget = alternate.target;
                        CompanionNavigationRecovery.clear(session);
                        TownChatter.say(session, BotAI, 'alternate-equipment-shop', Speech.lines('town.alternate-equipment-shop', { merchant: target.name, alternate: alternate.target.name }), { priority: 'coordination' });
                        return;
                    }
                }

                if (session.partyCompanion === true) {
                    const alternate = alternateTownNpcErrand(session, bot, town);
                    if (alternate) {
                        session.companionShopping = alternate;
                        session.shoppingTarget = alternate.target;
                        CompanionNavigationRecovery.clear(session);
                        TownChatter.say(session, BotAI, 'alternate-town-shop', Speech.lines('town.alternate-town-shop', { merchant: target.name || 'the shop', alternate: alternate.target.name }), { priority: 'coordination' });
                        return;
                    }
                }

                if (session.companionShopping?.kind === 'player_resource_purchase') {
                    // A supply run is hidden and parked cold: it ends through
                    // its normal return, which reveals the bot beside the
                    // leader and marks it hot. Stopping the AI keeps a second
                    // tick from re-entering here before the return fires.
                    TownNpcApproach.reset(session);
                    CompanionNavigationRecovery.clear(session);
                    BotAI.stop?.(session);
                    this.scheduleResourceReturn(session, bot, BotAI, { deliveryReady: false });
                    return;
                }

                const companionResume = session.resumeAfterShopping;
                if (session.companionShopping?.kind === 'sell_unused_arrows') {
                    this.finishInventoryUnload(session, bot, BotAI, true);
                    return;
                }
                const returningToCompanion = session.partyCompanion === true && companionResume?.followPlayerSession?.actor?.fetchIsOnline?.();
                deferEquipmentRetry(session);
                // A failed sale/restock route needs the same pause as an
                // equipment errand. Otherwise forced cleanup restarts it on
                // the next hunting tick, before any local fight can begin.
                TownTransitPolicy.defer(session, bot, 'shopping_route_unreachable');
                session.plan = returningToCompanion ? 'following' : 'hunting';
                // ARCH-NOTE: an unreachable shopping route also ends this town visit.
                if (session.plan === 'hunting') raiseDecision(session, 'goal_failed:visit', { impossible: true });
                session.shoppingDoneAnnounced = false;
                session.shoppingTarget = undefined;
                session.companionShopping = undefined;
                session.resumeAfterShopping = undefined;
                session.preShopLocation = undefined;
                clearShoppingServiceState(session);
                session.lastCompanionTownErrandAt = Date.now();
                session.roleDecision = {
                    ...(session.roleDecision || {}),
                    action: 'town_errand',
                    reason: 'shopping_route_unreachable',
                    at: Date.now()
                };
                TownNpcApproach.reset(session);
                CompanionNavigationRecovery.clear(session);
                bot.unselect?.();
                bot.automation?.abortAll?.(bot);
                TownChatter.say(session, BotAI, 'shop-unreachable', Speech.lines('town.shop-unreachable'), { priority: 'coordination' });
            }
            return;
        }

        if (session.shoppingServicePhase === 'workshop') {
            craftAtWorkshop(session, bot, target);
            return;
        }
        if (session.shoppingServicePhase === 'improvement') {
            Improvements.reviewHot(session).then(result => {
                if (result) { session.shoppingTarget = undefined; session.shoppingServicePhase = undefined;
                    session.shoppingDoneAnnounced = false; session.plan = 'hunting'; raiseDecision(session, 'goal_done:visit'); }
            }).catch(error => utils.infoWarn('Improvement', '%s', error));
            return;
        }

        // In town! Wait and pretend to shop
        TownNpcApproach.reset(session);
        CompanionNavigationRecovery.clear(session);
        if (session.shoppingServicePhase === 'warehouse') {
            if (!session.shoppingDoneAnnounced) {
                session.shoppingDoneAnnounced = true;
                this.depositAtWarehouse(session, bot, Generics, BotAI, target);
            }
            return;
        }
        if (!session.shoppingDoneAnnounced) {
            session.shoppingDoneAnnounced = true;
            BotEventJournal.record({
                botId: bot.fetchId(),
                eventType: 'shopping_started',
                summary: `${bot.fetchName?.() || 'Bot'} reached ${target.town || 'town'} to shop and restock.`,
                weight: 2,
                dedupeKey: `shopping:${bot.fetchId()}:${target.town || 'town'}`,
                coalesceWindowMs: 30000,
                meta: { town: target.town || null }
            });
            this.sellAndRestock(session, bot, Generics, BotAI);
        }
    },

    async depositAtWarehouse(session, bot, Generics, BotAI, target) {
        const errand = session.companionShopping;
        const unloading = errand?.kind === 'unload_inventory';
        try {
            const warehouse = await BotWarehouse.depositActorAtWarehouse(bot, session.coldLifeState, session, target,
                { unload: unloading });
            if (unloading && (session.actor !== bot || session.companionShopping !== errand || session.plan !== 'shopping')) return;
            session.shoppingWarehouseDone = true;
            session.lastTradeSummary = warehouse.count > 0
                ? `stored ${warehouse.count} items with ${target.name}`
                : `checked storage with ${target.name}; nothing to deposit`;
            if (warehouse.count > 0) {
                const sample = warehouse.items.slice(0, 2).map((item) => `${item.amount}x ${item.name}`).join(', ');
                const stored = `${sample}${warehouse.items.length > 2 ? ' and more' : ''}`;
                TownChatter.say(session, BotAI, 'warehouse-deposit', Speech.lines('town.warehouse-deposit', { items: stored, merchant: target.name }));
            }
            if (unloading) {
                this.finishInventoryUnload(session, bot, BotAI);
                return;
            }
            restoreAfterWarehouse(session);
            TownNpcApproach.reset(session);
            CompanionNavigationRecovery.clear(session);
        } catch (err) {
            if (unloading && (session.actor !== bot || session.companionShopping !== errand || session.plan !== 'shopping')) return;
            utils.infoWarn('Shopping', 'warehouse deposit failed for %s at %s: %s', bot.fetchName(), target?.name || 'unknown', err.message);
            session.lastTradeSummary = 'kept inventory after warehouse deposit failure';
            TownChatter.say(session, BotAI, 'warehouse-unavailable', Speech.lines('town.warehouse-unavailable', { merchant: target?.name || 'The warehouse clerk' }), { priority: 'coordination' });
            if (unloading) {
                if (session.actor === bot && session.companionShopping === errand && session.plan === 'shopping') {
                    this.finishInventoryUnload(session, bot, BotAI, true);
                }
            } else this.scheduleRestock(session, bot, Generics, BotAI);
        }
    },

    finishInventoryUnload(session, bot, BotAI, failed = false) {
        const leader = session.resumeAfterShopping?.followPlayerSession;
        const following = session.partyCompanion && session.followPlayerSession === leader && leader?.actor?.fetchIsOnline?.();
        session.companionUnloadRetryAt = failed || require('../../Population/SurvivalFloor').bagMarks(bot).weight
            ? Date.now() + InventoryCleanup.RETRY_MS : 0;
        session.plan = following ? 'following' : 'hunting';
        session.shoppingTarget = undefined;
        session.companionShopping = undefined;
        session.shoppingDoneAnnounced = false;
        session.resumeAfterShopping = undefined;
        session.preShopLocation = undefined;
        clearShoppingServiceState(session);
        if (session.coldLifeState) {
            session.coldLifeState = { ...session.coldLifeState, activity: session.plan,
                inventory: LifeState.inventorySummaryFromItems(bot.backpack.fetchItems()) };
            refreshPartyMemberships([session], invoke);
        }
        bot.statusUpdateVitals?.(bot);
        if (following && !bot.isDead?.()) {
            TownChatter.say(session, BotAI, 'return-to-party', Speech.lines('town.return-to-party'), { priority: 'coordination' });
            bot.moveTo({ from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                to: { locX: leader.actor.fetchLocX(), locY: leader.actor.fetchLocY(), locZ: leader.actor.fetchLocZ() } });
        } else if (!following) raiseDecision(session, failed ? 'goal_failed:visit' : 'goal_done:visit');
    },

    async sellAndRestock(session, bot, Generics, BotAI) {
        const companionErrand = session.companionShopping;
        const visit = { errand: companionErrand, target: session.shoppingTarget, shopTimer: session.shopTimer };

        // The unload's arrows go with the bot's ordinary NPC sale (SellJunk).
        if (companionErrand?.kind === 'sell_unused_arrows') {
            let failed = false;
            try {
                const sale = await invoke(path.world + 'NpcBypasses/SellJunk').sell(session);
                if (session.actor !== bot || session.companionShopping !== companionErrand || session.plan !== 'shopping') return;
                failed = !(sale.count > 0);
                session.lastTradeSummary = `sold ${sale.count} items for ${sale.payout}a`;
            } catch (error) {
                failed = true;
                utils.infoWarn('Shopping', 'unused arrow sale failed for %s: %s', bot.fetchName(), error.message);
            }
            if (session.actor === bot && session.companionShopping === companionErrand && session.plan === 'shopping') {
                this.finishInventoryUnload(session, bot, BotAI, failed);
            }
            return;
        }

        if (companionErrand?.kind === 'restock_shots') {
            this.scheduleRestock(session, bot, Generics, BotAI);
            return;
        }

        if (companionErrand?.kind === 'mammon_unseal') {
            try {
                await invoke('GameServer/Bot/AI/BotMammonUnseal').execute(session,bot,companionErrand);
                session.lastTradeSummary = 'unsealed my equipment at Mammon';
                if (session.actor !== bot || session.companionShopping !== companionErrand || session.plan !== 'shopping') return;
                if (continueEquipmentShopping(session,bot,BotAI,companionErrand)) return;
            } catch (error) {
                deferEquipmentRetry(session);
                session.lastTradeSummary = `unsealing failed: ${error.message}`;
            }
            if (session.actor === bot && session.companionShopping === companionErrand && session.plan === 'shopping') {
                this.scheduleRestock(session,bot,Generics,BotAI);
            }
            return;
        }

        if (['dual_component_withdrawal','dual_sword_combine'].includes(companionErrand?.kind)) {
            try {
                const result = await invoke('GameServer/Bot/AI/CompanionDualSwordCrafting').execute(session,bot,companionErrand);
                session.lastTradeSummary = result.completed ? 'equipped my dual swords'
                    : result.reason === 'components_withdrawn' ? 'collected my swords from the warehouse' : 'equipment needs another attempt';
                if (session.actor !== bot || session.companionShopping !== companionErrand || session.plan !== 'shopping') return;
                if (result.reason === 'components_withdrawn' && continueEquipmentShopping(session,bot,BotAI,companionErrand)) return;
                if (!result.completed) deferEquipmentRetry(session);
            } catch (error) {
                deferEquipmentRetry(session);
                session.lastTradeSummary = `equipment errand failed: ${error.message}`;
            }
            if (session.actor === bot && session.companionShopping === companionErrand && session.plan === 'shopping') {
                this.scheduleRestock(session,bot,Generics,BotAI);
            }
            return;
        }

        if (companionErrand?.kind === 'player_resource_purchase') {
            let deliveryReady = false;
            try {
                const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
                const purchased = await BotSupplyErrand.purchaseAtDestination(bot, companionErrand);
                if (purchased.pending) return;
                if (!purchased.ok || Number(purchased.delta) !== Number(companionErrand.amount)) {
                    throw new Error(purchased.reason || 'purchase_delta_mismatch');
                }
                const purchasedItem = purchased.item || bot.backpack.fetchItemFromSelfId(companionErrand.itemId);
                session.pendingResourceDelivery = {
                    playerSession: companionErrand.playerSession,
                    playerId: companionErrand.playerId,
                    workflowId: companionErrand.workflowId,
                    objectId: purchasedItem.fetchId(),
                    itemSelfId: Number(companionErrand.itemId),
                    itemName: companionErrand.itemName,
                    amount: Number(companionErrand.amount),
                    purchasedAt: Date.now()
                };
                if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(companionErrand.workflowId, 'return', {
                    botId: bot.fetchId(),
                    playerId: companionErrand.playerId,
                    itemSelfId: companionErrand.itemId,
                    amount: purchased.delta,
                    cost: purchased.cost
                }, 'pending', 'purchase_complete_returning');
                deliveryReady = true;
                session.lastTradeSummary = `bought ${purchased.delta}x ${companionErrand.itemName} for ${formatAdena(purchased.cost)}a to deliver to ${companionErrand.playerSession?.actor?.fetchName?.() || 'the leader'}`;
                TownChatter.say(session, BotAI, 'supply-purchased', Speech.lines('town.supply-purchased', { count: purchased.delta, item: companionErrand.itemName }), { priority: 'coordination' });
                BotEventJournal.record({
                    playerId: companionErrand.playerId,
                    botId: bot.fetchId(),
                    eventType: 'resource_purchase',
                    summary: `${bot.fetchName()} bought ${purchased.delta} ${companionErrand.itemName} to deliver to the party leader.`,
                    weight: 4,
                    dedupeKey: `resource_purchase:${bot.fetchId()}:${companionErrand.playerId}:${companionErrand.itemId}:${companionErrand.amount}:${Date.now()}`,
                    meta: {
                        itemSelfId: companionErrand.itemId,
                        amount: purchased.delta,
                        cost: purchased.cost,
                        requestedBy: companionErrand.playerId
                    }
                });
            } catch (error) {
                session.pendingResourceDelivery = undefined;
                session.lastTradeSummary = `could not buy ${companionErrand.amount}x ${companionErrand.itemName}`;
                TownChatter.say(session, BotAI, 'supply-purchase-failed', error?.message === 'not_enough_adena'
            ? Speech.lines('town.supply-purchase-failed.short-adena')
            : Speech.lines('town.supply-purchase-failed.unavailable'), { priority: 'coordination' });
                utils.infoWarn('Shopping', 'requested supply purchase failed for %s: %s', bot.fetchName(), error.message);
                if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(companionErrand.workflowId, 'return', {
                    botId: bot.fetchId(),
                    playerId: companionErrand.playerId,
                    itemSelfId: companionErrand.itemId,
                    amount: companionErrand.amount
                }, 'failed', error?.message || 'purchase_failed', { terminal: false });
            }
            this.scheduleResourceReturn(session, bot, BotAI, { deliveryReady });
            return;
        }

        if (companionErrand?.kind === 'market_purchase') {
            let purchaseSucceeded = false;
            const { store, name: sellerName } = targetStore(companionErrand.target);
            try {
                const storeItem = store?.items?.find((item) => Number(item.selfId) === Number(companionErrand.itemId)
                    && (store.afkTrade !== true || Number(item.afkTradeLineId) === Number(companionErrand.lineId)));
                if (store?.afkTrade === true && !storeItem) throw new Error('afk_trade_stock_changed');
                await freeStepBids(bot, companionErrand);
                let bought = store?.afkTrade === true
                    ? await AfkTradeService.buyFromShop(
                        bot.fetchId(), store, companionErrand.itemId, companionErrand.amount || 1,
                        { lineId: companionErrand.lineId, expectedPrice: companionErrand.price, coldState: session.coldLifeState,
                            funding: companionErrand.funding }
                    )
                    : await TradeService.buyFromStore(bot, store, companionErrand.itemId, companionErrand.amount || 1,
                        { objectId: companionErrand.objectId, expectedUnitPrice: companionErrand.price,
                            funding: companionErrand.funding });
                if (bought.pending) {
                    const receipt = await waitForShoppingMeeting(session, bot, bought, visit);
                    if (receipt.interrupted) return;
                    if (receipt.outcome !== 'completed') throw Error('trade_meeting_cancelled');
                    bought = { amount: companionErrand.amount || 1,
                        totalPrice: (companionErrand.amount || 1) * companionErrand.price };
                }
                const boughtSummary = store?.afkTrade === true
                    ? { qty: bought.amount, name: storeItem?.name || companionErrand.itemName, totalAdena: bought.totalPrice }
                    : bought;
                if (bought.coldState) {
                    session.coldLifeState = bought.coldState;
                    refreshPartyMemberships([session], invoke);
                }
                await withdrawBuyOrderFor(bot, companionErrand.itemId);
                BotEquipmentUpgrade.applyBestUpgrades(session, { force: true });
                clearCompletedMarketPlan(session, bot, {
                    selfId: companionErrand.itemId,
                    price: boughtSummary.totalAdena / boughtSummary.qty,
                    sourceType: companionErrand.sourceType || 'private_store',
                    sourceId: store?.ownerId || companionErrand.target.actorId
                });
                session.lastTradeSummary = `bought ${boughtSummary.qty}x ${boughtSummary.name} from ${sellerName} for ${formatAdena(boughtSummary.totalAdena)}a`;
                TownChatter.say(session, BotAI, 'market-gear-purchased', Speech.lines('town.market-gear-purchased', { item: boughtSummary.name, seller: sellerName }),
                    { values: { item: boughtSummary.name, seller: sellerName } });
                purchaseSucceeded = true;
            } catch (err) {
                equipmentPurchaseFailed(session, bot, companionErrand, err);
                TownChatter.say(session, BotAI, 'market-offer-gone', Speech.lines('town.market-offer-gone'));
            }
            if (purchaseSucceeded) await invoke('GameServer/Bot/BotSkillTraining').review(session);
            if (purchaseSucceeded && continueEquipmentShopping(session, bot, BotAI, companionErrand)) return;
            this.scheduleRestock(session, bot, Generics, BotAI);
            return;
        }

        if (companionErrand?.kind === 'npc_equipment_purchase') {
            let purchaseSucceeded = false;
            try {
                const offer = MarketOpportunity.npcOffers(companionErrand.itemId, companionErrand.target.town)
                    .find((candidate) => (
                        Number(candidate.sourceId) === Number(companionErrand.sourceId)
                        && Number(candidate.price) === Number(companionErrand.price)
                        && ['locX', 'locY', 'locZ'].every(key => candidate[key] == null
                            || Number(candidate[key]) === Number(companionErrand.target[key]))
                    ));
                if (!offer) throw new Error('npc_offer_unavailable');
                await freeStepBids(bot, companionErrand);
                const seller = { ...offer, locX: Number(companionErrand.target.locX),
                    locY: Number(companionErrand.target.locY), locZ: Number(companionErrand.target.locZ) };
                const result = await invoke('GameServer/Bot/Economy/NpcRestockPlan').purchaseForActor(bot, {
                    town: offer.town, seller, extras: [{ selfId: companionErrand.itemId,
                        amount: companionErrand.amount || 1, offer: seller, funding: companionErrand.funding, autoEquip: true }] });
                if (session.actor !== bot || !LifeState.hotRow(bot.fetchId())) return;
                const line = result.receipts.flatMap(row => row.lines || [])
                    .find(row => Number(row.selfId) === Number(companionErrand.itemId));
                if (!result.ok || !line) throw Error(result.ok ? 'npc_line_not_funded'
                    : result.receipts.find(row => !row.ok)?.reason || 'npc_offer_unavailable');
                const bought = { qty: line.amount, name: offer.itemName, totalAdena: line.amount * line.unitPrice };
                await withdrawBuyOrderFor(bot, companionErrand.itemId);
                BotEquipmentUpgrade.applyBestUpgrades(session, { force: true });
                clearCompletedMarketPlan(session, bot, {
                    selfId: companionErrand.itemId,
                    price: bought.totalAdena / bought.qty,
                    sourceType: 'npc',
                    sourceId: companionErrand.sourceId
                });
                session.lastTradeSummary = `bought ${bought.qty}x ${bought.name} from ${companionErrand.target.name} for ${formatAdena(bought.totalAdena)}a`;
                TownChatter.say(session, BotAI, 'npc-gear-purchased', Speech.lines('town.npc-gear-purchased', { item: bought.name, seller: companionErrand.target.name }),
                    { values: { item: bought.name, seller: companionErrand.target.name } });
                purchaseSucceeded = true;
            } catch (err) {
                equipmentPurchaseFailed(session, bot, companionErrand, err);
                TownChatter.say(session, BotAI, 'npc-gear-purchase-failed', err?.message === 'Not enough Adena.'
            ? Speech.lines('town.npc-gear-purchase-failed.short-adena')
            : Speech.lines('town.npc-gear-purchase-failed.unavailable'), { priority: 'coordination' });
            }
            if (purchaseSucceeded) await invoke('GameServer/Bot/BotSkillTraining').review(session);
            if (purchaseSucceeded && continueEquipmentShopping(session, bot, BotAI, companionErrand)) return;
            this.scheduleRestock(session, bot, Generics, BotAI);
            return;
        }

        if (companionErrand?.kind === 'restock_shots') {
            this.scheduleRestock(session, bot, Generics, BotAI);
            return;
        }

        let soldToBuyer = false;

        if (session.shoppingTarget?.actorId || session.shoppingTarget?.recordId) {
            const { store, actor: buyer, name: buyerName } = targetStore(session.shoppingTarget);

            if (store && store.storeType === 3) {
                try {
                    let result = store.afkTrade === true
                        ? await sellInventoryToAfk(bot, store, session.coldLifeState, session.shoppingTarget.sale || null)
                        : await TradeService.sellInventoryToStore(bot, store, {
                        buyerActor: buyer,
                        state: session.coldLifeState,
                        sale: session.shoppingTarget.sale
                        });
                    if (result.pending) {
                        const receipt = await waitForShoppingMeeting(session, bot, result, visit);
                        if (receipt.interrupted) return;
                        if (receipt.outcome !== 'completed') throw Error('trade_meeting_cancelled');
                        const sale = result.pendingSale;
                        result = { ...result, pending: false, coldState: session.coldLifeState,
                            itemsSold: result.itemsSold + sale.qty, totalAdena: result.totalAdena + sale.totalAdena,
                            sold: [...result.sold, sale] };
                    }
                    if (result.coldState) {
                        session.coldLifeState = result.coldState;
                        refreshPartyMemberships([session], invoke);
                    }
                    if (result.itemsSold > 0) {
                        soldToBuyer = true;
                        const sample = result.sold.slice(0, 3).map((line) => `${line.qty}x ${line.name}`).join(', ');
                        session.lastTradeSummary = `sold ${result.itemsSold} to ${buyerName} for ${formatAdena(result.totalAdena)}a`;
                        TownChatter.say(session, BotAI, 'loot-sold', Speech.lines('town.loot-sold', { items: sample, buyer: buyerName, adena: formatAdena(result.totalAdena) }));
                    }
                } catch (err) {
                    utils.infoWarn("Shopping", "buyer sale failed for %s: %s", bot.fetchName(), err);
                }
            }
        }

        if (!soldToBuyer) {
            sellJunk(session);
            session.lastTradeSummary = `used general sell-junk at ${session.shoppingTarget?.town || 'town'}`;
        } else {
            // Clear only the leftovers that neither a buyer nor the warehouse wanted.
            sellJunk(session);
        }

        this.scheduleRestock(session, bot, Generics, BotAI);
    },

    scheduleRestock(session, bot, Generics, BotAI) {
        if (session.shoppingRestock) return;
        if (!session.shoppingLiveShotStopChecked) {
            session.shoppingLiveShotStopChecked = true;
            const town = TownTransitPolicy.townAt(bot);
            // Before the sale settles: the visit's kit is not fixed yet.
            const target = ShotStock.liveRestockTarget(bot, town, heldShoppingKit(session, town));
            if (target && (!session.shoppingTarget || Number(session.shoppingTarget.actorId) !== target.actorId)) {
                session.companionShopping = { kind: 'restock_shots', target };
                session.shoppingTarget = target;
                session.shoppingServicePhase = 'merchant';
                session.shoppingDoneAnnounced = false;
                CompanionNavigationRecovery.clear(session);
                TownNpcApproach.reset(session);
                return;
            }
        }
        let completeRestock;
        const restockWork = new Promise(resolve => { completeRestock = resolve; });
        session.shoppingRestock = restockWork;
        let restockFailure = null;
        setTimeout(async () => {
            if (session.actor !== bot || session.plan !== 'shopping' || session.shoppingRestock !== restockWork) {
                completeRestock();
                return;
            }
            try {
                const plan = ShotStock.planForActor(bot);
                const expectedCost = 0;
                const potionPlan = HealingPotionStock.purchasePotionFor(bot);
                const potionTown = session.shoppingTarget?.town
                    || session.coldLifeState?.currentRegion
                    || BotAI.getClosestTown?.(
                        bot.fetchLocX(),
                        bot.fetchLocY(),
                        bot.fetchLocZ()
                    )?.name;
                const potionPrice = HealingPotionStock.localNpcPrice(potionPlan, potionTown);
                const NpcRestock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
                const shotQuote = NpcRestock.quoteFor(plan.selfId, potionTown);
                await session.shoppingSale;
                if (session.actor !== bot || session.plan !== 'shopping') return;
                const kit = shoppingKit(session, bot, potionTown);
                const board = await ShotStock.purchaseActorRestock(bot, { plan, town: potionTown || null,
                    unitPrice: shotQuote?.price, potionUnitPrice: potionPrice || undefined, skipNpc: true, kit });
                if (session.actor !== bot || !LifeState.hotRow(bot.fetchId())) return;
                const basket = await NpcRestock.purchaseForActor(bot, { town: potionTown, kit });
                if (session.actor !== bot || !LifeState.hotRow(bot.fetchId())) return;
                const lines = basket.receipts.flatMap(row => row.lines || []);
                const potion = lines.find(row => Number(row.selfId) === Number(potionPlan.selfId));
                if (potion) TownChatter.say(session, BotAI, 'healing-potions-restocked', Speech.lines('town.healing-potions-restocked', {
                    count: potion.amount, item: potionPlan.name, reserve: formatAdena(HealingPotionStock.operationalReserve(bot)) }));
                const shot = lines.find(row => Number(row.selfId) === Number(plan.selfId));
                const result = { ok: basket.ok && board.ok, delta: Number(board.delta || 0) + Number(shot?.amount || 0),
                    cost: Number(board.cost || 0) + Number(shot?.amount || 0) * Number(shot?.unitPrice || 0),
                    adena: Number(bot.backpack.fetchItemFromSelfId(57)?.fetchAmount?.() || 0) };
                if (!result.ok) {
                    restockFailure = 'restock_incomplete';
                    TownChatter.say(session, BotAI, 'shots-too-expensive', Speech.lines('town.shots-too-expensive', { item: ShotStock.describe(plan), adena: result.adena || 0, cost: result.cost || expectedCost }),
                        { priority: 'coordination', values: { item: ShotStock.describe(plan) } });
                } else {
                    if (result.delta > 0) {
                        TownChatter.say(session, BotAI, 'shots-restocked', Speech.lines('town.shots-restocked', { count: result.delta, item: ShotStock.describe(plan), cost: formatAdena(result.cost) }));
                    } else {
                        TownChatter.say(session, BotAI, 'shots-already-stocked', Speech.lines('town.shots-already-stocked', { item: ShotStock.describe(plan) }));
                    }
                    session.dataSendToOthers(ServerResponse.skillStarted(bot, bot.fetchId(), { fetchSelfId: () => 2001, fetchCalculatedHitTime: () => 500, fetchReuseTime: () => 500 }), bot);
                }
                if (session.coldLifeState) {
                    session.coldLifeState = {
                        ...session.coldLifeState,
                        adena: Number(bot.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0),
                        inventory: LifeState.inventorySummaryFromItems(bot.backpack?.fetchItems?.() || [])
                    };
                    refreshPartyMemberships([session], invoke);
                }
            } catch (err) {
                restockFailure = err.message;
                utils.infoWarn('Shopping', 'consumable restock failed for %s: %s', bot.fetchName(), err.message);
            } finally {
                completeRestock();
            }
        }, 4000);

        setTimeout(async () => {
            await restockWork;
            if (session.actor !== bot || session.plan !== 'shopping' || session.shoppingRestock !== restockWork) return;
            if (!LifeState.hotRow(bot.fetchId())) return;
            session.shoppingRestock = undefined;
            if (restockFailure) {
                session.shoppingRestockFailures = Number(session.shoppingRestockFailures || 0) + 1;
                // A failed restock is tried again at once (its purchase waits its own
                // counter delay), up to its attempts; a meeting that took the bot
                // meanwhile owns it, so the visit ends instead.
                if (session.shoppingRestockFailures < MAX_RESTOCK_ATTEMPTS && !shoppingMeetingPending(session, bot)) {
                    session.lastDecision = { action: 'shopping_retry', reason: restockFailure, at: Date.now() };
                    this.scheduleRestock(session, bot, Generics, BotAI);
                    return;
                }
            }
            const companionResume = session.resumeAfterShopping;
            const returningToCompanion = session.partyCompanion === true && companionResume?.followPlayerSession?.actor?.fetchIsOnline?.();
            // A solo bot's rebuff heard its town arrival (arrive; a guide answer is
            // carried out from the hunt, HuntingState); a player's companion renews its
            // blessing at the guide before it returns (its own threshold, player-led).
            const townBuffVisit = returningToCompanion ? HotTownRebuff.syncVisit(session, bot, BotAI) : null;
            const rebuffBeforeLeaving = HotTownRebuff.needsVisit(session, townBuffVisit)
                && !!HotTownRebuff.tripGuide(session, bot, BotAI);
            session.plan = rebuffBeforeLeaving
                ? 'getting_buffed'
                : (returningToCompanion ? 'following' : 'hunting');
            // The visit's end, its restock bought or given up: the bot's look at the market
            // (as a far visit's), then the build takes the next leaf. A buff stop after it
            // belongs to this visit and raises nothing.
            replaceStats(session, GoalExecutor.townLooked(statsFor(session)));
            if (!returningToCompanion) raiseDecision(session, restockFailure ? 'goal_failed:visit' : 'goal_done:visit');
            BotEventJournal.record({
                botId: bot.fetchId(),
                eventType: restockFailure ? 'shopping_deferred' : 'shopping_completed',
                summary: restockFailure
                    ? `${bot.fetchName?.() || 'Bot'} deferred shopping after ${restockFailure} and returned to ${session.plan}.`
                    : `${bot.fetchName?.() || 'Bot'} finished shopping and returned to ${session.plan}.`,
                weight: 2,
                dedupeKey: `shopping_done:${bot.fetchId()}`,
                coalesceWindowMs: 30000,
                meta: { plan: session.plan, ...(restockFailure ? { reason: restockFailure } : {}) }
            });
            session.shoppingDoneAnnounced = false;
            session.shoppingTarget = undefined;
            session.companionShopping = undefined;
            clearShoppingServiceState(session);

            if (rebuffBeforeLeaving) {
                session.preBuffLocation = {
                    locX: bot.fetchLocX(),
                    locY: bot.fetchLocY(),
                    locZ: bot.fetchLocZ()
                };
                session.preBuffPlan = returningToCompanion ? 'following' : 'hunting';
                session.resumeAfterBuff = {
                    ...(returningToCompanion ? companionResume : {}),
                    plan: returningToCompanion ? 'following' : 'hunting',
                    townVisitKey: townBuffVisit.key
                };
                session.preShopLocation = undefined;
                session.resumeAfterShopping = undefined;
                TownChatter.say(session, BotAI, 'shopping-to-rebuff', Speech.lines('town.shopping-to-rebuff'));
                return;
            }

            if (returningToCompanion) {
                TownChatter.say(session, BotAI, 'return-to-party', Speech.lines('town.return-to-party'), { priority: 'coordination' });
            } else {
                // HuntingState chooses the actual hunting ground. Let it name
                // that destination once, then leave town through a gatekeeper.
                session.pendingFarmDepartureAnnouncement = true;
            }

            let returnTarget = null;
            if (returningToCompanion) {
                const leader = companionResume.followPlayerSession.actor;
                returnTarget = {
                    locX: leader.fetchLocX(),
                    locY: leader.fetchLocY(),
                    locZ: leader.fetchLocZ()
                };
                session.preShopLocation = undefined;
            } else {
                // Do not path directly from a town building to the old field.
                // The next hunting tick will pick a suitable spot and route to
                // the local gatekeeper first.
                session.preShopLocation = undefined;
            }
            session.resumeAfterShopping = undefined;

            if (returnTarget) {
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: returnTarget
                });
            }
        }, 9000);
    },

    scheduleResourceReturn(session, bot, BotAI, options = {}) {
        setTimeout(() => {
            const resume = session.resumeAfterShopping;
            const workflowId = session.companionShopping?.workflowId || session.pendingResourceDelivery?.workflowId || resume?.workflowId || options.workflowId;
            const wasSupplyErrand = session.supplyErrandPhase === 'cold' || session.supplyErrandPhase === 'shopping';
            if (wasSupplyErrand) {
                session.supplyErrandPhase = 'returning';
                BotAI.stop?.(session);
            }
            const leaderSession = resume?.followPlayerSession;
            session.plan = session.partyCompanion === true && leaderSession?.actor?.fetchIsOnline?.()
                ? 'following'
                : 'hunting';
            // ARCH-NOTE: hidden supply errands already advance in their cold round.
            if (session.plan === 'hunting' && !wasSupplyErrand) raiseDecision(session, 'goal_done:visit');
            session.shoppingDoneAnnounced = false;
            session.shoppingTarget = undefined;
            session.companionShopping = undefined;
            session.resumeAfterShopping = undefined;
            session.preShopLocation = undefined;
            clearShoppingServiceState(session);
            if (session.coldLifeState) {
                session.coldLifeState = { ...session.coldLifeState, activity: session.plan };
                refreshPartyMemberships([session], invoke);
            }
            const restoreHot = () => {
                session.supplyErrandPhase = undefined;
                BotTownTravel.revealSupplyErrand(session, bot);
                if (!session.aiActive) BotAI.init?.(session);
            };
            if (session.plan === 'following') {
                const leader = leaderSession.actor;
                const destination = {
                    locX: leader.fetchLocX() + 80,
                    locY: leader.fetchLocY(),
                    locZ: leader.fetchLocZ()
                };
                // A requested supply run is intentionally invisible while it
                // is away. Reappear in a valid companion slot instead of
                // making the player watch a long return route.
                bot.setLocXYZ?.(destination);
                BotTownTravel.returnSupplyHot(session, 'supply_errand_return', () => {
                    restoreHot();
                    TownChatter.say(session, BotAI, 'supply-return', options.deliveryReady === true
            ? Speech.lines('town.supply-return.ready')
            : Speech.lines('town.supply-return.empty'), { priority: 'coordination' });
                    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(workflowId, 'return', {
                        botId: bot.fetchId(),
                        playerId: leaderSession?.actor?.fetchId?.() || null,
                        deliveryReady: options.deliveryReady === true
                    }, options.deliveryReady === true ? 'completed' : 'failed', options.deliveryReady === true ? 'returned_to_leader' : 'purchase_failed', { terminal: options.deliveryReady !== true });
                });
            } else {
                session.pendingResourceDelivery = undefined;
                // The leader may have disconnected during the errand. Reveal
                // through the same packet path even when there is no return
                // target; otherwise every nearby client keeps a ghost bot.
                BotTownTravel.returnSupplyHot(session, 'supply_errand_leader_offline', () => {
                    restoreHot();
                    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(workflowId, 'return', {
                        botId: bot.fetchId(),
                        deliveryReady: false,
                        leaderOnline: false
                    }, 'failed', 'leader_offline', { terminal: true });
                });
            }
        }, 1000);
    }
};
