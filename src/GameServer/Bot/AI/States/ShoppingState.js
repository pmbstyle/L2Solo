const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const SpeckMath      = invoke('GameServer/SpeckMath');
const ServerResponse = invoke('GameServer/Network/Response');
const TradeService   = invoke('GameServer/Bot/TradeService');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const BotTownTravel  = invoke('GameServer/Bot/AI/BotTownTravel');
const BotWarehouse   = invoke('GameServer/Bot/Economy/BotWarehouseService');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const LifeState      = invoke('GameServer/Bot/Population/BotLifeState');
const GoalExecutor   = invoke('GameServer/Bot/Goals/GoalExecutor');
const Cooldown       = invoke('GameServer/Bot/Population/Cooldown');
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

const COMPANION_EQUIPMENT_FAILURE_RETRY_MS = 5 * 60 * 1000;

function findStoreSession(actorId) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    return BotManager.findSessionById(actorId)
        || (invoke('GameServer/World/World').user?.sessions || []).find((session) => session.actor?.fetchId?.() === actorId)
        || invoke('GameServer/AfkTrade/AfkTradeService').findProjection(actorId)?.session
        || null;
}

function findAfkBuyer(bot, town) {
    let best = null;
    (bot.backpack?.fetchItems?.() || []).forEach((item) => {
        if (item.fetchEquipped?.() || Number(item.fetchSelfId?.()) === 57) return;
        const offer = MarketOpportunity.findBuyOffers(item.fetchSelfId(), {
            town: town?.name,
            sellerCharacterId: bot.fetchId()
        }).find((candidate) => candidate.sourceType === 'afk_player_buy_store');
        if (!offer) return;
        const qty = Math.min(Number(item.fetchAmount?.() || 0), Number(offer.count || 0));
        if (qty <= 0) return;
        const score = qty * Number(offer.price || 0);
        if (!best || score > best.score) best = { offer, score };
    });
    return best;
}

async function sellInventoryToAfk(bot, store, coldState = null) {
    const sold = [];
    let state = coldState;
    const candidates = (bot.backpack?.fetchItems?.() || []).map((item) => ({
        objectId: Number(item.fetchId?.()),
        selfId: Number(item.fetchSelfId?.()),
        amount: Number(item.fetchAmount?.()),
        equipped: item.fetchEquipped?.() === true
    })).filter((item) => !item.equipped && item.selfId !== 57 && item.amount > 0);
    for (const item of candidates) {
        const projection = invoke('GameServer/AfkTrade/AfkTradeService').findProjection(
            PROJECTION_ID_FOR_STORE(store)
        );
        const currentStore = projection?.actor?.fetchPrivateStore?.() || store;
        const line = currentStore.items?.find((entry) => Number(entry.selfId) === item.selfId && Number(entry.count) > 0);
        if (!line) continue;
        const qty = Math.min(item.amount, Number(line.count));
        const result = await invoke('GameServer/AfkTrade/AfkTradeService').sellToShop(
            bot.fetchId(), currentStore, item.selfId, qty,
            { objectId: item.objectId, expectedPrice: line.price, coldState: state }
        );
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

function PROJECTION_ID_FOR_STORE(store) {
    return Number(store?.projectionObjectId || store?.merchantObjectId || 900000000 + Number(store?.shopId || 0));
}

function formatAdena(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function clearCompletedMarketPlan(session, bot, purchase) {
    const state = session.coldLifeState;
    if (!state) return;

    const equipmentPlan = state.stats?.equipmentPlan;
    const combineResultId = Number(equipmentPlan?.combine?.resultId || 0);
    const componentPurchase = combineResultId > 0
        && Number(equipmentPlan?.target?.selfId || 0) !== combineResultId;
    const stats = { ...(state.stats || {}) };
    if (!componentPurchase) delete stats.equipmentPlan;
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
        Number(errand.slot || 0)
    ].filter(Boolean))];
    const next = CompanionEquipmentShopping.planErrand(
        session,
        bot,
        town,
        Number(errand.purchaseCount || 0) + 1,
        excludedSlots
    );
    if (!next) return false;

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
    if (!town?.name || !['sell_resources', 'sell_junk', 'restock_shots'].includes(errand?.kind)) return null;
    const failedSourceIds = new Set((errand.failedSourceIds || []).map(Number));
    const failedNpcSelfId = Number(session.shoppingTarget?.npcSelfId || 0);
    if (failedNpcSelfId) failedSourceIds.add(failedNpcSelfId);
    const selfId = errand.kind === 'restock_shots'
        ? Number(ShotStock.planForActor(bot)?.selfId || 0)
        : 0;
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

function deferEquipmentRetry(session) {
    if (!['npc_equipment_purchase', 'market_purchase'].includes(session.companionShopping?.kind)) return;
    session.companionEquipmentRetryAt = Date.now() + COMPANION_EQUIPMENT_FAILURE_RETRY_MS;
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

function clearShoppingServiceState(session) {
    session.shoppingServicePhase = undefined;
    session.shoppingWarehouseDone = undefined;
    session.shoppingAfterWarehouseTarget = undefined;
    session.failedWarehouseNpcSelfIds = undefined;
    session.shoppingEquipmentPlanChecked = undefined;
}

function prepareEquipmentMarketStop(session, bot, town, BotAI) {
    const plan = session.coldLifeState?.stats?.equipmentPlan;
    if (session.companionShopping || session.shoppingTarget || session.shoppingEquipmentPlanChecked) return false;
    if (!town?.name || Number(session.companionEquipmentRetryAt || 0) > Date.now()) return false;
    if (plan?.strategy !== 'market' || Number(plan.target?.selfId || 0) <= 0) return false;

    // One indexed lookup per town visit is enough. If the offer disappears,
    // the normal purchase failure cooldown handles the next attempt.
    session.shoppingEquipmentPlanChecked = true;
    const errand = CompanionEquipmentShopping.planErrand(session, bot, town);
    if (!errand) return false;
    session.companionShopping = errand;
    session.shoppingTarget = errand.target;
    session.shoppingDoneAnnounced = false;
    CompanionNavigationRecovery.clear(session);
    TownChatter.say(session, BotAI, 'equipment-market-selected', Speech.lines('town.equipment-market-selected', { item: errand.itemName, seller: errand.target.name }));
    return true;
}

function prepareWarehouseStop(session, bot, town, BotAI) {
    if (session.shoppingServicePhase === 'warehouse') return true;
    if (session.shoppingWarehouseDone || !usesWarehouseStop(session)) return false;
    if (!BotWarehouse.hasActorDepositCandidates(bot, session.coldLifeState)) {
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

module.exports = {
    tick(session, bot, Generics, BotAI) {
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

        prepareEquipmentMarketStop(session, bot, closestTown, BotAI);
        prepareWarehouseStop(session, bot, closestTown, BotAI);

        if (!session.shoppingTarget) {
            const BotManager = invoke('GameServer/Bot/BotManager');
            const buyer = TradeService.findBestBuyerForActor(bot, BotManager.sessions, {
                town: closestTown,
                state: session.coldLifeState
            });
            const afkBuyer = findAfkBuyer(bot, closestTown);

            if (afkBuyer && (!buyer || Number(afkBuyer.score) >= Number(buyer.preview?.totalAdena || 0))) {
                const offer = afkBuyer.offer;
                session.shoppingTarget = {
                    actorId: offer.projection.actor.fetchId(),
                    name: offer.sourceName,
                    locX: offer.locX,
                    locY: offer.locY,
                    locZ: offer.locZ,
                    town: offer.town || closestTown.name
                };
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
        const readyToInteract = npcApproach?.ready === true
            || (!npcApproach && distToTarget <= 300);

        if (!readyToInteract) {
            const navigationTarget = npcApproach?.destination || target;
            const navigation = CompanionNavigationRecovery.move(session, bot, navigationTarget, 'shopping', {
                targetActor: npcApproach ? null : targetActor,
                ...(npcApproach ? { arrivalRadius: npcApproach.arrivalRadius } : {})
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

                const companionResume = session.resumeAfterShopping;
                const returningToCompanion = session.partyCompanion === true && companionResume?.followPlayerSession?.actor?.fetchIsOnline?.();
                deferEquipmentRetry(session);
                session.plan = returningToCompanion ? 'following' : 'hunting';
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
            Promise.resolve(BotEventJournal.record({
                botId: bot.fetchId(),
                eventType: 'shopping_started',
                summary: `${bot.fetchName?.() || 'Bot'} reached ${target.town || 'town'} to shop and restock.`,
                weight: 2,
                dedupeKey: `shopping:${bot.fetchId()}:${target.town || 'town'}`,
                coalesceWindowMs: 30000,
                meta: { town: target.town || null }
            })).catch(() => {});
            this.sellAndRestock(session, bot, Generics, BotAI);
        }
    },

    async depositAtWarehouse(session, bot, Generics, BotAI, target) {
        try {
            const warehouse = await BotWarehouse.depositActorAtWarehouse(
                bot,
                session.coldLifeState,
                session,
                target
            );
            session.shoppingWarehouseDone = true;
            session.lastTradeSummary = warehouse.count > 0
                ? `stored ${warehouse.count} items with ${target.name}`
                : `checked storage with ${target.name}; nothing to deposit`;
            if (warehouse.count > 0) {
                const sample = warehouse.items.slice(0, 2).map((item) => `${item.amount}x ${item.name}`).join(', ');
                const stored = `${sample}${warehouse.items.length > 2 ? ' and more' : ''}`;
                TownChatter.say(session, BotAI, 'warehouse-deposit', Speech.lines('town.warehouse-deposit', { items: stored, merchant: target.name }));
            }
            restoreAfterWarehouse(session);
            TownNpcApproach.reset(session);
            CompanionNavigationRecovery.clear(session);
        } catch (err) {
            utils.infoWarn('Shopping', 'warehouse deposit failed for %s at %s: %s', bot.fetchName(), target?.name || 'unknown', err.message);
            session.lastTradeSummary = 'kept inventory after warehouse deposit failure';
            TownChatter.say(session, BotAI, 'warehouse-unavailable', Speech.lines('town.warehouse-unavailable', { merchant: target?.name || 'The warehouse clerk' }), { priority: 'coordination' });
            this.scheduleRestock(session, bot, Generics, BotAI);
        }
    },

    async sellAndRestock(session, bot, Generics, BotAI) {
        const NpcTalkResponse = invoke(path.world + 'NpcTalkResponse');
        const companionErrand = session.companionShopping;

        if (companionErrand?.kind === 'player_resource_purchase') {
            let deliveryReady = false;
            try {
                const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
                const purchased = await BotSupplyErrand.purchaseAtDestination(bot, companionErrand);
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
                WorkflowTelemetry.recordSupply(companionErrand.workflowId, 'return', {
                    botId: bot.fetchId(),
                    playerId: companionErrand.playerId,
                    itemSelfId: companionErrand.itemId,
                    amount: purchased.delta,
                    cost: purchased.cost
                }, 'pending', 'purchase_complete_returning');
                deliveryReady = true;
                session.lastTradeSummary = `bought ${purchased.delta}x ${companionErrand.itemName} for ${formatAdena(purchased.cost)}a to deliver to ${companionErrand.playerSession?.actor?.fetchName?.() || 'the leader'}`;
                TownChatter.say(session, BotAI, 'supply-purchased', Speech.lines('town.supply-purchased', { count: purchased.delta, item: companionErrand.itemName }), { priority: 'coordination' });
                Promise.resolve(BotEventJournal.record({
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
                })).catch(() => {});
            } catch (error) {
                session.pendingResourceDelivery = undefined;
                session.lastTradeSummary = `could not buy ${companionErrand.amount}x ${companionErrand.itemName}`;
                TownChatter.say(session, BotAI, 'supply-purchase-failed', error?.message === 'not_enough_adena'
            ? Speech.lines('town.supply-purchase-failed.short-adena')
            : Speech.lines('town.supply-purchase-failed.unavailable'), { priority: 'coordination' });
                utils.infoWarn('Shopping', 'requested supply purchase failed for %s: %s', bot.fetchName(), error.message);
                WorkflowTelemetry.recordSupply(companionErrand.workflowId, 'return', {
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
            const sellerSession = findStoreSession(companionErrand.target.actorId);
            const seller = sellerSession?.actor;
            const store = seller?.fetchPrivateStore?.();
            try {
                const storeItem = store?.items?.find((item) => Number(item.selfId) === Number(companionErrand.itemId));
                const bought = store?.afkTrade === true
                    ? await invoke('GameServer/AfkTrade/AfkTradeService').buyFromShop(
                        bot.fetchId(), store, companionErrand.itemId, 1,
                        { expectedPrice: companionErrand.price, coldState: session.coldLifeState }
                    )
                    : await TradeService.buyFromStore(bot, store, companionErrand.itemId, 1, {
                    afterPurchase: sellerSession?.coldMarketState
                        ? async (purchaseResult) => {
                            const updatedSeller = await LifeState.applyMarketSale(sellerSession.coldMarketState, {
                                selfId: companionErrand.itemId,
                                price: purchaseResult.totalAdena / purchaseResult.qty,
                                buyerCharacterId: bot.fetchId(),
                                storeItem
                            }, purchaseResult.qty);
                            if (updatedSeller) sellerSession.coldMarketState = updatedSeller;
                        }
                        : null
                    });
                const boughtSummary = store?.afkTrade === true
                    ? { qty: bought.amount, name: storeItem?.name || companionErrand.itemName, totalAdena: bought.totalPrice }
                    : bought;
                if (bought.coldState) session.coldLifeState = bought.coldState;
                BotEquipmentUpgrade.applyBestUpgrades(session, { force: true });
                session.companionEquipmentRetryAt = undefined;
                clearCompletedMarketPlan(session, bot, {
                    selfId: companionErrand.itemId,
                    price: boughtSummary.totalAdena / boughtSummary.qty,
                    sourceType: companionErrand.sourceType || 'private_store',
                    sourceId: store?.ownerId || seller.fetchId()
                });
                session.lastTradeSummary = `bought ${boughtSummary.qty}x ${boughtSummary.name} from ${seller.fetchName()} for ${formatAdena(boughtSummary.totalAdena)}a`;
                TownChatter.say(session, BotAI, 'market-gear-purchased', Speech.lines('town.market-gear-purchased', { item: boughtSummary.name, seller: seller.fetchName() }));
                purchaseSucceeded = true;

                if (!store.items.some((item) => Number(item.count || 0) > 0) && sellerSession?.coldMarketState) {
                    const returnState = GoalExecutor.finishMarketVisit(sellerSession.coldMarketState);
                    if (returnState) {
                        await Cooldown.transitionToColdState(sellerSession, {
                            ...returnState,
                            stats: { ...(returnState.stats || {}), marketStore: null }
                        }, 'market_sold_out');
                    }
                }
            } catch (err) {
                deferEquipmentRetry(session);
                session.lastTradeSummary = `could not buy ${companionErrand.itemName || companionErrand.itemId}`;
                TownChatter.say(session, BotAI, 'market-offer-gone', Speech.lines('town.market-offer-gone'));
            }
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
                    ));
                if (!offer) throw new Error('npc_offer_unavailable');
                const store = {
                    storeType: 1,
                    items: [{ selfId: companionErrand.itemId, price: offer.price, count: 1 }]
                };
                const bought = await TradeService.buyFromStore(bot, store, companionErrand.itemId, 1, {
                    expectedUnitPrice: companionErrand.price
                });
                BotEquipmentUpgrade.applyBestUpgrades(session, { force: true });
                session.companionEquipmentRetryAt = undefined;
                clearCompletedMarketPlan(session, bot, {
                    selfId: companionErrand.itemId,
                    price: bought.totalAdena / bought.qty,
                    sourceType: 'npc',
                    sourceId: companionErrand.sourceId
                });
                session.lastTradeSummary = `bought ${bought.qty}x ${bought.name} from ${companionErrand.target.name} for ${formatAdena(bought.totalAdena)}a`;
                TownChatter.say(session, BotAI, 'npc-gear-purchased', Speech.lines('town.npc-gear-purchased', { item: bought.name, seller: companionErrand.target.name }));
                purchaseSucceeded = true;
            } catch (err) {
                deferEquipmentRetry(session);
                session.lastTradeSummary = `could not buy ${companionErrand.itemName || companionErrand.itemId}`;
                TownChatter.say(session, BotAI, 'npc-gear-purchase-failed', err?.message === 'Not enough Adena.'
            ? Speech.lines('town.npc-gear-purchase-failed.short-adena')
            : Speech.lines('town.npc-gear-purchase-failed.unavailable'), { priority: 'coordination' });
            }
            if (purchaseSucceeded && continueEquipmentShopping(session, bot, BotAI, companionErrand)) return;
            this.scheduleRestock(session, bot, Generics, BotAI);
            return;
        }

        if (companionErrand?.kind === 'restock_shots') {
            this.scheduleRestock(session, bot, Generics, BotAI);
            return;
        }

        let soldToBuyer = false;

        if (session.shoppingTarget?.actorId) {
            const buyerSession = findStoreSession(session.shoppingTarget.actorId);
            const buyer = buyerSession?.actor;
            const store = buyer && buyer.fetchPrivateStore ? buyer.fetchPrivateStore() : null;

            if (store && store.storeType === 3) {
                try {
                    const result = store.afkTrade === true
                        ? await sellInventoryToAfk(bot, store, session.coldLifeState)
                        : await TradeService.sellInventoryToStore(bot, store, {
                        buyerActor: buyer,
                        state: session.coldLifeState,
                        afterTrade: store.budgetBacked === true && buyerSession?.coldMarketState
                            ? () => LifeState.syncMarketSession(buyerSession, 'hot_bot_market_buy_fill')
                            : null
                        });
                    if (result.coldState) session.coldLifeState = result.coldState;
                    if (result.itemsSold > 0) {
                        soldToBuyer = true;
                        const sample = result.sold.slice(0, 3).map((line) => `${line.qty}x ${line.name}`).join(', ');
                        session.lastTradeSummary = `sold ${result.itemsSold} to ${buyer.fetchName()} for ${formatAdena(result.totalAdena)}a`;
                        TownChatter.say(session, BotAI, 'loot-sold', Speech.lines('town.loot-sold', { items: sample, buyer: buyer.fetchName(), adena: formatAdena(result.totalAdena) }));
                    }
                } catch (err) {
                    utils.infoWarn("Shopping", "buyer sale failed for %s: %s", bot.fetchName(), err);
                }
            }
        }

        if (!soldToBuyer) {
            NpcTalkResponse(session, { link: 'sell-junk' });
            session.lastTradeSummary = `used general sell-junk at ${session.shoppingTarget?.town || 'town'}`;
        } else {
            // Clear only the leftovers that neither a buyer nor the warehouse wanted.
            NpcTalkResponse(session, { link: 'sell-junk' });
        }

        this.scheduleRestock(session, bot, Generics, BotAI);
    },

    scheduleRestock(session, bot, Generics, BotAI) {
        setTimeout(() => {
            const plan = ShotStock.planForActor(bot);
            const current = ShotStock.shotAmount(bot, plan);
            const amount = Math.max(0, ShotStock.PURCHASE_TARGET_AMOUNT - current);
            const expectedCost = amount * Number(plan.price || 0);

            ShotStock.purchaseActorRestock(bot, {
                plan,
                targetAmount: ShotStock.PURCHASE_TARGET_AMOUNT
            }).then(async (result) => {
                if (!result.ok) {
                    TownChatter.say(session, BotAI, 'shots-too-expensive', Speech.lines('town.shots-too-expensive', { item: ShotStock.describe(plan), adena: result.adena || 0, cost: result.cost || expectedCost }), { priority: 'coordination' });
                    return;
                }

                if (result.delta > 0) {
                    TownChatter.say(session, BotAI, 'shots-restocked', Speech.lines('town.shots-restocked', { count: result.delta, item: ShotStock.describe(plan), cost: formatAdena(result.cost) }));
                } else {
                    TownChatter.say(session, BotAI, 'shots-already-stocked', Speech.lines('town.shots-already-stocked', { item: ShotStock.describe(plan) }));
                }
                session.dataSendToOthers(ServerResponse.skillStarted(bot, bot.fetchId(), { fetchSelfId: () => 2001, fetchCalculatedHitTime: () => 500, fetchReuseTime: () => 500 }), bot);

                const potionPlan = HealingPotionStock.purchasePotionFor(bot);
                const potionTown = session.shoppingTarget?.town
                    || session.coldLifeState?.currentRegion
                    || BotAI.getClosestTown?.(
                        bot.fetchLocX(),
                        bot.fetchLocY(),
                        bot.fetchLocZ()
                    )?.name;
                const potionOffer = potionTown
                    ? MarketOpportunity.npcOffers(potionPlan.selfId, potionTown)
                        .filter((offer) => offer.available !== false && Number(offer.price || 0) > 0)
                        .sort((left, right) => Number(left.price) - Number(right.price))[0]
                    : null;
                const potionResult = potionOffer
                    ? await HealingPotionStock.purchaseActorRestock(bot, {
                        potion: potionPlan,
                        unitPrice: potionOffer.price
                    })
                    : { ok: false, reason: 'no_local_offer' };
                if (potionResult.ok && potionResult.changed) {
                    TownChatter.say(session, BotAI, 'healing-potions-restocked', Speech.lines('town.healing-potions-restocked', { count: potionResult.amount, item: potionResult.potion.name, reserve: formatAdena(potionResult.reserve) }));
                }
                if (session.coldLifeState) {
                    session.coldLifeState = {
                        ...session.coldLifeState,
                        adena: Number(bot.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0),
                        inventory: LifeState.inventorySummaryFromItems(bot.backpack?.fetchItems?.() || [])
                    };
                }
            }).catch((err) => {
                utils.infoWarn('Shopping', 'shot restock failed for %s: %s', bot.fetchName(), err.message);
            });
        }, 4000);

        setTimeout(() => {
            const companionResume = session.resumeAfterShopping;
            const returningToCompanion = session.partyCompanion === true && companionResume?.followPlayerSession?.actor?.fetchIsOnline?.();
            const townBuffVisit = HotTownRebuff.syncVisit(session, bot, BotAI);
            const rebuffBeforeLeaving = HotTownRebuff.needsVisit(session, townBuffVisit)
                && Number(session.newbieGuideRetryAt || 0) <= Date.now();
            session.plan = rebuffBeforeLeaving
                ? 'getting_buffed'
                : (returningToCompanion ? 'following' : 'hunting');
            Promise.resolve(BotEventJournal.record({
                botId: bot.fetchId(),
                eventType: 'shopping_completed',
                summary: `${bot.fetchName?.() || 'Bot'} finished shopping and returned to ${session.plan}.`,
                weight: 2,
                dedupeKey: `shopping_done:${bot.fetchId()}`,
                coalesceWindowMs: 30000,
                meta: { plan: session.plan }
            })).catch(() => {});
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
            session.shoppingDoneAnnounced = false;
            session.shoppingTarget = undefined;
            session.companionShopping = undefined;
            session.resumeAfterShopping = undefined;
            session.preShopLocation = undefined;
            clearShoppingServiceState(session);
            if (session.coldLifeState) {
                session.coldLifeState = { ...session.coldLifeState, activity: session.plan };
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
                const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
                Promise.resolve().then(() => PopulationService.markHot(session, 'supply_errand_return')).catch(() => null).then(() => {
                    restoreHot();
                    TownChatter.say(session, BotAI, 'supply-return', options.deliveryReady === true
            ? Speech.lines('town.supply-return.ready')
            : Speech.lines('town.supply-return.empty'), { priority: 'coordination' });
                    WorkflowTelemetry.recordSupply(workflowId, 'return', {
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
                const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
                Promise.resolve().then(() => PopulationService.markHot(session, 'supply_errand_leader_offline')).catch(() => null).then(() => {
                    restoreHot();
                    WorkflowTelemetry.recordSupply(workflowId, 'return', {
                        botId: bot.fetchId(),
                        deliveryReady: false,
                        leaderOnline: false
                    }, 'failed', 'leader_offline', { terminal: true });
                });
            }
        }, 1000);
    }
};
