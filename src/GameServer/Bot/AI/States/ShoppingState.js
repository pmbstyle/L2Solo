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
        || null;
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
        TownChatter.say(session, BotAI, 'warehouse-not-in-town', [
            'There is no warehouse service available; I will keep the protected items with me.',
            'No warehouse clerk is available. I will carry the valuables instead of selling them.',
            'There is no usable warehouse, so the protected items stay in my bag.',
            'Skipping storage; I will keep anything worth preserving.'
        ], { priority: 'coordination' });
        return false;
    }

    session.shoppingAfterWarehouseTarget = session.shoppingTarget;
    session.shoppingTarget = target;
    session.shoppingServicePhase = 'warehouse';
    session.shoppingDoneAnnounced = false;
    CompanionNavigationRecovery.clear(session);
    TownNpcApproach.reset(session);
    TownChatter.say(session, BotAI, 'warehouse-selected', [
        `Stopping at ${target.name}'s warehouse before I visit the shops.`,
        `I will leave the protected items with ${target.name}, then handle the market.`,
        `Warehouse first: ${target.name} can store the valuables from this run.`,
        `Taking the keepers to ${target.name} before I sell the leftovers.`
    ]);
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
            TownChatter.say(session, BotAI, 'shopping-cancelled', [
                'Shopping can wait. Staying with the party.',
                "I'll leave the shopping for later and stick with you.",
                'Never mind the shops — staying with the group.',
                "I'll handle the errands next time we're in town."
            ]);
            return;
        }

        if (session.townEscape) {
            if (BotTownTravel.hasCombatThreat(session, bot) || !bot.state.fetchCasts()) {
                BotTownTravel.interruptEscape(session, bot);
            }
            return;
        }

        const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());

        prepareWarehouseStop(session, bot, closestTown, BotAI);

        if (!session.shoppingTarget) {
            const BotManager = invoke('GameServer/Bot/BotManager');
            const buyer = TradeService.findBestBuyerForActor(bot, BotManager.sessions, {
                town: closestTown,
                state: session.coldLifeState
            });

            if (buyer) {
                session.shoppingTarget = {
                    actorId: buyer.actor.fetchId(),
                    name: buyer.actor.fetchName(),
                    locX: buyer.actor.fetchLocX(),
                    locY: buyer.actor.fetchLocY(),
                    locZ: buyer.actor.fetchLocZ(),
                    town: buyer.store.town || closestTown.name
                };
                TownChatter.say(session, BotAI, 'buyer-selected', [
                    `Taking this loot to ${session.shoppingTarget.name} in ${session.shoppingTarget.town}.`,
                    `${session.shoppingTarget.name} is buying, so I'll sell there.`,
                    `Found a buyer in ${session.shoppingTarget.town}: ${session.shoppingTarget.name}.`,
                    `I'll see what ${session.shoppingTarget.name} offers for this haul.`
                ]);
            } else {
                session.shoppingTarget = townMerchantTarget(closestTown, bot);
                if (!session.shoppingTarget) {
                    session.plan = 'hunting';
                    session.shoppingDoneAnnounced = false;
                    session.preShopLocation = undefined;
                    clearShoppingServiceState(session);
                    TownChatter.say(session, BotAI, 'npc-seller-unavailable', [
                        'No merchant service is available, so I will keep the bag and try again later.',
                        'I could not find a real shopkeeper. Nothing will be discarded.',
                        'There is no usable NPC shop right now; I will retry on another visit.',
                        'No merchant can handle this errand, so I am keeping the inventory.'
                    ], { priority: 'coordination' });
                    return;
                }
                TownChatter.say(session, BotAI, 'npc-seller-selected', [
                    `No player buyer for this haul; I'll use ${session.shoppingTarget.name}'s shop in ${session.shoppingTarget.town}.`,
                    `No good market offer. Taking the leftovers to ${session.shoppingTarget.name} in ${session.shoppingTarget.town}.`,
                    `The market passed on this bag, so ${session.shoppingTarget.name} in ${session.shoppingTarget.town} gets it.`,
                    `I'll clear this inventory at ${session.shoppingTarget.name}'s NPC shop in ${session.shoppingTarget.town}.`
                ]);
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
                        TownChatter.say(session, BotAI, 'alternate-warehouse', [
                            `I couldn't reach ${target.name}; trying warehouse keeper ${alternate.name}.`,
                            `${target.name}'s counter is blocked. I will store the items with ${alternate.name}.`,
                            `Switching warehouse clerks — ${alternate.name} should be reachable.`,
                            `No route to ${target.name}; heading to ${alternate.name} instead.`
                        ], { priority: 'coordination' });
                        return;
                    }

                    session.shoppingWarehouseDone = 'unreachable';
                    restoreAfterWarehouse(session);
                    TownNpcApproach.reset(session);
                    CompanionNavigationRecovery.clear(session);
                    TownChatter.say(session, BotAI, 'warehouse-unreachable', [
                        'I could not reach a warehouse clerk, so I will keep the protected items with me.',
                        'No usable route to the warehouse. I will carry the valuables and continue.',
                        'Storage is inaccessible; nothing protected will be sold.',
                        'The warehouse route failed. Keeping the important items in my bag.'
                    ], { priority: 'coordination' });
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
                        TownChatter.say(session, BotAI, 'alternate-equipment-shop', [
                            `I couldn't reach ${target.name}; trying ${alternate.target.name} instead.`,
                            `${target.name} is blocked off. I'll check ${alternate.target.name}.`,
                            `Changing shops — ${alternate.target.name} should be reachable.`,
                            `No route to ${target.name}. Heading for ${alternate.target.name}.`
                        ], { priority: 'coordination' });
                        return;
                    }
                }

                if (session.partyCompanion === true) {
                    const alternate = alternateTownNpcErrand(session, bot, town);
                    if (alternate) {
                        session.companionShopping = alternate;
                        session.shoppingTarget = alternate.target;
                        CompanionNavigationRecovery.clear(session);
                        TownChatter.say(session, BotAI, 'alternate-town-shop', [
                            `I couldn't reach ${target.name || 'the shop'}; trying ${alternate.target.name} instead.`,
                            `That route is blocked. Switching to ${alternate.target.name}.`,
                            `${alternate.target.name} is my next stop; this shop is inaccessible.`,
                            `Taking another route through ${alternate.target.name}.`
                        ], { priority: 'coordination' });
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
                TownChatter.say(session, BotAI, 'shop-unreachable', [
                    "I couldn't reach the shop. Staying with you and I'll retry later.",
                    'That shop is inaccessible, so I will retry later.',
                    "No usable route to the merchant. I'll retry later.",
                    "The shop route failed; I'll try again on the next town visit."
                ], { priority: 'coordination' });
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
                TownChatter.say(session, BotAI, 'warehouse-deposit', [
                    `Stored ${stored} with warehouse keeper ${target.name}.`,
                    `${target.name} put ${stored} away for safekeeping.`,
                    `Warehouse stop complete with ${target.name}: ${stored}.`,
                    `Left ${stored} in ${target.name}'s care before visiting the shops.`
                ]);
            }
            restoreAfterWarehouse(session);
            TownNpcApproach.reset(session);
            CompanionNavigationRecovery.clear(session);
        } catch (err) {
            utils.infoWarn('Shopping', 'warehouse deposit failed for %s at %s: %s', bot.fetchName(), target?.name || 'unknown', err.message);
            session.lastTradeSummary = 'kept inventory after warehouse deposit failure';
            TownChatter.say(session, BotAI, 'warehouse-unavailable', [
                `${target?.name || 'The warehouse clerk'} could not accept this load. I will keep the bag and try again later.`,
                'Warehouse service failed, so I am keeping these items for now.',
                'Could not deposit this load. Nothing will be discarded.',
                'The warehouse is unavailable; I will carry the protected items until next time.'
            ], { priority: 'coordination' });
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
                TownChatter.say(session, BotAI, 'supply-purchased', [
                    `Bought ${purchased.delta}x ${companionErrand.itemName}. Returning with them now.`,
                    `${purchased.delta}x ${companionErrand.itemName} secured; heading back.`,
                    `Got the requested ${companionErrand.itemName}. On my way back.`,
                    `Supply run complete: ${purchased.delta}x ${companionErrand.itemName}. Returning now.`
                ], { priority: 'coordination' });
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
                    ? [
                        'I am short on Adena for that purchase. Give me some and I will try again.',
                        'I could not cover the supply bill. I need more Adena before another attempt.',
                        'The requested supplies cost more Adena than I have.',
                        'Purchase paused — my Adena is short for the requested amount.'
                    ]
                    : [
                        'I could not complete that supply purchase. I am returning now.',
                        'The supply run failed at the shop; heading back empty-handed.',
                        'I could not secure the requested goods. Returning to the party.',
                        'That purchase did not go through. I am coming back now.'
                    ], { priority: 'coordination' });
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
                const bought = await TradeService.buyFromStore(bot, store, companionErrand.itemId, 1, {
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
                BotEquipmentUpgrade.applyBestUpgrades(session, { force: true });
                session.companionEquipmentRetryAt = undefined;
                clearCompletedMarketPlan(session, bot, {
                    selfId: companionErrand.itemId,
                    price: bought.totalAdena / bought.qty,
                    sourceType: 'private_store',
                    sourceId: seller.fetchId()
                });
                session.lastTradeSummary = `bought ${bought.qty}x ${bought.name} from ${seller.fetchName()} for ${formatAdena(bought.totalAdena)}a`;
                TownChatter.say(session, BotAI, 'market-gear-purchased', [
                    `Bought ${bought.name} from ${seller.fetchName()}.`,
                    `${seller.fetchName()} had the ${bought.name}; upgrade secured.`,
                    `Picked up ${bought.name} from ${seller.fetchName()}.`,
                    `${bought.name} is mine now. Good market find.`
                ]);
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
                TownChatter.say(session, BotAI, 'market-offer-gone', [
                    'That market offer is gone already. I will keep looking later.',
                    'Too late — that listing sold. I will check again another time.',
                    'The seller no longer has it. Leaving that upgrade for later.',
                    'Market stock changed before I arrived; I will retry on a future visit.'
                ]);
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
                TownChatter.say(session, BotAI, 'npc-gear-purchased', [
                    `Bought ${bought.name} from ${companionErrand.target.name}.`,
                    `${companionErrand.target.name} had the ${bought.name}; equipped and ready.`,
                    `Upgrade found: ${bought.name} from ${companionErrand.target.name}.`,
                    `Picked up ${bought.name}. That should help.`
                ]);
                purchaseSucceeded = true;
            } catch (err) {
                deferEquipmentRetry(session);
                session.lastTradeSummary = `could not buy ${companionErrand.itemName || companionErrand.itemId}`;
                TownChatter.say(session, BotAI, 'npc-gear-purchase-failed', err?.message === 'Not enough Adena.'
                    ? [
                        'I am short on Adena for that equipment. I will try again later.',
                        'That upgrade is out of my budget for now.',
                        'Not enough Adena for this gear yet; leaving it for another visit.',
                        'I found the upgrade, but cannot afford it this time.'
                    ]
                    : [
                        'That NPC offer is unavailable now. I will try again later.',
                        'The shop no longer has that upgrade available.',
                        'Could not complete the NPC purchase; I will revisit the plan later.',
                        'That item is not available from this shop anymore.'
                    ], { priority: 'coordination' });
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
                    const result = await TradeService.sellInventoryToStore(bot, store, {
                        buyerActor: buyer,
                        state: session.coldLifeState,
                        afterTrade: store.budgetBacked === true && buyerSession?.coldMarketState
                            ? () => LifeState.syncMarketSession(buyerSession, 'hot_bot_market_buy_fill')
                            : null
                    });
                    if (result.itemsSold > 0) {
                        soldToBuyer = true;
                        const sample = result.sold.slice(0, 3).map((line) => `${line.qty}x ${line.name}`).join(', ');
                        session.lastTradeSummary = `sold ${result.itemsSold} to ${buyer.fetchName()} for ${formatAdena(result.totalAdena)}a`;
                        TownChatter.say(session, BotAI, 'loot-sold', [
                            `Sold ${sample} to ${buyer.fetchName()} for ${formatAdena(result.totalAdena)} Adena.`,
                            `${buyer.fetchName()} took ${sample}; earned ${formatAdena(result.totalAdena)} Adena.`,
                            `Trade done with ${buyer.fetchName()}: ${formatAdena(result.totalAdena)} Adena for ${sample}.`,
                            `Turned ${sample} into ${formatAdena(result.totalAdena)} Adena at ${buyer.fetchName()}'s store.`
                        ]);
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
                    TownChatter.say(session, BotAI, 'shots-too-expensive', [
                        `Not enough Adena for ${ShotStock.describe(plan)} (${result.adena || 0}/${result.cost || expectedCost}). Skipping restock.`,
                        `${ShotStock.describe(plan)} cost ${result.cost || expectedCost}, but I only have ${result.adena || 0} Adena.`,
                        `Short on Adena for ${ShotStock.describe(plan)}; I will manage without a refill.`,
                        `Cannot afford the shot restock this visit (${result.adena || 0}/${result.cost || expectedCost}).`
                    ], { priority: 'coordination' });
                    return;
                }

                if (result.delta > 0) {
                    TownChatter.say(session, BotAI, 'shots-restocked', [
                        `Restocked ${result.delta}x ${ShotStock.describe(plan)} for ${formatAdena(result.cost)} Adena.`,
                        `${result.delta}x ${ShotStock.describe(plan)} packed and ready.`,
                        `Shot supply topped up: ${result.delta}x ${ShotStock.describe(plan)}.`,
                        `Spent ${formatAdena(result.cost)} Adena and refilled ${ShotStock.describe(plan)}.`
                    ]);
                } else {
                    TownChatter.say(session, BotAI, 'shots-already-stocked', [
                        `Still stocked on ${ShotStock.describe(plan)}.`,
                        `No shot purchase needed; I have enough ${ShotStock.describe(plan)}.`,
                        `${ShotStock.describe(plan)} supply is already fine.`,
                        `Skipping the shot counter — stock is good.`
                    ]);
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
                    TownChatter.say(session, BotAI, 'healing-potions-restocked', [
                        `Added ${potionResult.amount}x ${potionResult.potion.name} for emergencies; I kept ${formatAdena(potionResult.reserve)} Adena in reserve.`,
                        `Emergency stock ready: ${potionResult.amount}x ${potionResult.potion.name}.`,
                        `Picked up ${potionResult.amount}x ${potionResult.potion.name} without touching my reserve.`,
                        `${potionResult.amount}x ${potionResult.potion.name} packed for low-HP fights.`
                    ]);
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
                TownChatter.say(session, BotAI, 'shopping-to-rebuff', [
                    'Shopping done. Getting a fresh Newbie Guide blessing before I leave town.',
                    'Errands finished; one quick blessing refresh before we go.',
                    'Supplies are sorted. I am stopping by the Newbie Guide next.',
                    'Done with the shops — heading for a fresh blessing now.'
                ]);
                return;
            }

            if (returningToCompanion) {
                TownChatter.say(session, BotAI, 'return-to-party', [
                    'All set. Returning to you.',
                    'Errands complete; heading back to the party.',
                    'Finished in town. On my way back.',
                    'Bag sorted and gear checked — returning now.'
                ], { priority: 'coordination' });
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
                        ? [
                            'I am back with the new supplies. I will open trade when the party is safe.',
                            'Supplies delivered to camp; I will trade them over when it is safe.',
                            'Back with the goods. Waiting for a safe moment to open trade.',
                            'The supply run is complete. I have the requested items ready to trade.'
                        ]
                        : [
                            'I am back, but I could not complete that purchase.',
                            'Returned to the party without the requested supplies.',
                            'The shop run failed, but I am back with the group.',
                            'No goods this time — the purchase could not be completed.'
                        ], { priority: 'coordination' });
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
