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

    const { equipmentPlan, ...stats } = state.stats || {};
    session.coldLifeState = {
        ...state,
        adena: Number(bot.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || state.adena || 0),
        stats: {
            ...stats,
            lastMarketPurchase: {
                selfId: Number(purchase.selfId),
                price: Number(purchase.price),
                sourceType: 'private_store',
                sourceId: Number(purchase.sellerId),
                at: Date.now()
            }
        }
    };
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        if (session.partyCompanion === true && session.followPlayerSession && !session.companionShopping) {
            session.plan = 'following';
            session.shoppingTarget = undefined;
            session.shoppingDoneAnnounced = false;
            session.preShopLocation = undefined;
            BotAI.say(session, "Shopping can wait. Staying with the party.");
            return;
        }

        if (session.townEscape) {
            if (BotTownTravel.hasCombatThreat(session, bot) || !bot.state.fetchCasts()) {
                BotTownTravel.interruptEscape(session, bot);
            }
            return;
        }

        const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY());

        if (!session.shoppingTarget) {
            const BotManager = invoke('GameServer/Bot/BotManager');
            const buyer = TradeService.findBestBuyerForActor(bot, BotManager.sessions, { town: closestTown });

            if (buyer) {
                session.shoppingTarget = {
                    actorId: buyer.actor.fetchId(),
                    name: buyer.actor.fetchName(),
                    locX: buyer.actor.fetchLocX(),
                    locY: buyer.actor.fetchLocY(),
                    locZ: buyer.actor.fetchLocZ(),
                    town: buyer.store.town || closestTown.name
                };
                BotAI.say(session, `Heading to ${session.shoppingTarget.name} in ${session.shoppingTarget.town} to sell loot.`);
            } else {
                session.shoppingTarget = {
                    actorId: null,
                    name: `${closestTown.name} general shop`,
                    locX: closestTown.x,
                    locY: closestTown.y,
                    locZ: closestTown.z,
                    town: closestTown.name
                };
                BotAI.say(session, `No player buyer wants this bag. Going to ${closestTown.name} to liquidate junk.`);
            }
        }

        const target = session.shoppingTarget;
        const distToTarget = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
            .distance(new SpeckMath.Point3D(target.locX, target.locY, target.locZ));

        if (distToTarget > 300) {
            bot.moveTo({
                from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                to: { locX: target.locX, locY: target.locY, locZ: target.locZ }
            });
            return;
        }

        // In town! Wait and pretend to shop
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
                    objectId: purchasedItem.fetchId(),
                    itemSelfId: Number(companionErrand.itemId),
                    itemName: companionErrand.itemName,
                    amount: Number(companionErrand.amount),
                    purchasedAt: Date.now()
                };
                deliveryReady = true;
                session.lastTradeSummary = `bought ${purchased.delta}x ${companionErrand.itemName} for ${formatAdena(purchased.cost)}a to deliver to ${companionErrand.playerSession?.actor?.fetchName?.() || 'the leader'}`;
                BotAI.say(session, `Bought ${purchased.delta}x ${companionErrand.itemName}. Returning with them now.`);
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
                BotAI.say(session, error?.message === 'not_enough_adena'
                    ? 'I am short on Adena for that purchase. Give me some and I will try again.'
                    : 'I could not complete that supply purchase. I am returning now.');
                utils.infoWarn('Shopping', 'requested supply purchase failed for %s: %s', bot.fetchName(), error.message);
            }
            this.scheduleResourceReturn(session, bot, BotAI, { deliveryReady });
            return;
        }

        if (companionErrand?.kind === 'market_purchase') {
            const sellerSession = findStoreSession(companionErrand.target.actorId);
            const seller = sellerSession?.actor;
            const store = seller?.fetchPrivateStore?.();
            try {
                const bought = await TradeService.buyFromStore(bot, store, companionErrand.itemId, 1);
                if (sellerSession?.coldMarketState) {
                    const updatedSeller = await LifeState.applyMarketSale(sellerSession.coldMarketState, {
                        selfId: companionErrand.itemId,
                        price: bought.totalAdena / bought.qty,
                        buyerCharacterId: bot.fetchId(),
                        storeItem: store.items.find((item) => Number(item.selfId) === Number(companionErrand.itemId))
                    }, bought.qty);
                    if (updatedSeller) sellerSession.coldMarketState = updatedSeller;
                }
                clearCompletedMarketPlan(session, bot, {
                    selfId: companionErrand.itemId,
                    price: bought.totalAdena / bought.qty,
                    sellerId: seller.fetchId()
                });
                BotEquipmentUpgrade.applyBestUpgrades(session);
                session.lastTradeSummary = `bought ${bought.qty}x ${bought.name} from ${seller.fetchName()} for ${formatAdena(bought.totalAdena)}a`;
                BotAI.say(session, `Bought ${bought.name} from ${seller.fetchName()}.`);

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
                session.lastTradeSummary = `could not buy ${companionErrand.itemName || companionErrand.itemId}`;
                BotAI.say(session, 'That market offer is gone already. I will keep looking later.');
            }
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
                    const result = await TradeService.sellInventoryToStore(bot, store);
                    if (result.itemsSold > 0) {
                        soldToBuyer = true;
                        const sample = result.sold.slice(0, 3).map((line) => `${line.qty}x ${line.name}`).join(', ');
                        session.lastTradeSummary = `sold ${result.itemsSold} to ${buyer.fetchName()} for ${formatAdena(result.totalAdena)}a`;
                        BotAI.say(session, `Sold ${sample} to ${buyer.fetchName()} for ${formatAdena(result.totalAdena)} Adena.`);
                    }
                } catch (err) {
                    utils.infoWarn("Shopping", "buyer sale failed for %s: %s", bot.fetchName(), err);
                }
            }
        }

        // Do this before the generic junk-sell bypass: materials and useful
        // gear that no buyer accepted belong in the bot's own warehouse.
        let warehouse;
        try {
            warehouse = await BotWarehouse.depositActor(bot);
        } catch (err) {
            // The generic sell-junk bypass would destroy the very items we
            // meant to protect, so keep the bag intact and retry next visit.
            utils.infoWarn('Shopping', 'warehouse deposit failed for %s: %s', bot.fetchName(), err.message);
            session.lastTradeSummary = 'kept inventory after warehouse deposit failure';
            BotAI.say(session, 'My warehouse clerk is unavailable. I will keep this bag and try again later.');
            this.scheduleRestock(session, bot, Generics, BotAI);
            return;
        }
        if (warehouse.count > 0) {
            const sample = warehouse.items.slice(0, 2).map((item) => `${item.amount}x ${item.name}`).join(', ');
            BotAI.say(session, `Stored ${sample}${warehouse.items.length > 2 ? ' and more' : ''} in my warehouse.`);
        }

        if (!soldToBuyer) {
            NpcTalkResponse(session, { link: 'sell-junk' });
            session.lastTradeSummary = `${warehouse.count ? `stored ${warehouse.count}, then ` : ''}used general sell-junk at ${session.shoppingTarget?.town || 'town'}`;
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
            const amount = Math.max(0, ShotStock.DEFAULT_TARGET_AMOUNT - current);
            const expectedCost = amount * Number(plan.price || 0);

            ShotStock.purchaseActorRestock(bot, {
                plan,
                targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT
            }).then((result) => {
                if (!result.ok) {
                    BotAI.say(session, `Not enough Adena to buy ${ShotStock.describe(plan)} (Have ${result.adena || 0}/${result.cost || expectedCost} Adena). Skipping restocking.`);
                    return;
                }

                if (result.delta > 0) {
                    BotAI.say(session, `Bought ${result.delta}x ${ShotStock.describe(plan)} (-${formatAdena(result.cost)} Adena)!`);
                } else {
                    BotAI.say(session, `Still stocked on ${ShotStock.describe(plan)}.`);
                }
                session.dataSendToOthers(ServerResponse.skillStarted(bot, bot.fetchId(), { fetchSelfId: () => 2001, fetchCalculatedHitTime: () => 500, fetchReuseTime: () => 500 }), bot);
            }).catch((err) => {
                utils.infoWarn('Shopping', 'shot restock failed for %s: %s', bot.fetchName(), err.message);
            });
        }, 4000);

        setTimeout(() => {
            const companionResume = session.resumeAfterShopping;
            const returningToCompanion = session.partyCompanion === true && companionResume?.followPlayerSession?.actor?.fetchIsOnline?.();
            BotAI.say(session, returningToCompanion ? "All set. Returning to you." : "All stocked up! Returning to the hunting spot.");
            session.plan = session.partyCompanion === true && session.followPlayerSession ? 'following' : 'hunting';
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

            let returnTarget = null;
            if (returningToCompanion) {
                const leader = companionResume.followPlayerSession.actor;
                returnTarget = {
                    locX: leader.fetchLocX(),
                    locY: leader.fetchLocY(),
                    locZ: leader.fetchLocZ()
                };
                session.preShopLocation = undefined;
            } else if (session.preShopLocation) {
                returnTarget = session.preShopLocation;
                session.preShopLocation = undefined;
            } else if (session.initialSpawnCoord) {
                returnTarget = session.initialSpawnCoord;
            } else {
                returnTarget = { locX: -81174, locY: 246037, locZ: -3719 };
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
            const leaderSession = resume?.followPlayerSession;
            session.plan = session.partyCompanion === true && leaderSession?.actor?.fetchIsOnline?.()
                ? 'following'
                : 'hunting';
            session.shoppingDoneAnnounced = false;
            session.shoppingTarget = undefined;
            session.companionShopping = undefined;
            session.resumeAfterShopping = undefined;
            session.preShopLocation = undefined;
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
                session.supplyErrandHidden = false;
                const Response = invoke('GameServer/Network/Response');
                session.dataSendToOthers?.(Response.charInfo(bot), bot);
                session.dataSendToOthers?.(Response.relationChanged(bot), bot);
                BotAI.say(session, options.deliveryReady === true
                    ? 'I am back with the new supplies. I will open trade when the party is safe.'
                    : 'I am back, but I could not complete that purchase.');
            } else {
                session.pendingResourceDelivery = undefined;
                session.supplyErrandHidden = false;
            }
        }, 1000);
    }
};
