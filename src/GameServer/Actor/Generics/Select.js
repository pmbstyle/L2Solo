const ServerResponse = invoke('GameServer/Network/Response');
const World          = invoke('GameServer/World/World');
const DataCache      = invoke('GameServer/DataCache');
const Item           = invoke('GameServer/Item/Item');
const SummonControl  = invoke('GameServer/Npc/SummonControl');
const TradeService   = invoke('GameServer/Bot/TradeService');
const merchantPurchaseItems = invoke('GameServer/Network/MerchantPurchaseItems');

function merchantDemandRows(actor, store) {
    const rows = [];

    TradeService.nativeStoreItems(store).forEach((storeItem) => {
        const inventoryItem = actor.backpack.fetchItems().find((item) => (
            item.fetchSelfId() === storeItem.selfId &&
            !item.fetchEquipped() &&
            item.fetchSelfId() !== 57
        ));

        if (inventoryItem) {
            const quote = TradeService.storeSaleQuote(store, storeItem, actor, inventoryItem);
            rows.push({
                item: inventoryItem,
                amount: Math.min(inventoryItem.fetchAmount(), quote.count),
                price: quote.price
            });
            return;
        }

        DataCache.fetchItemFromSelfId(storeItem.selfId, (item) => {
            rows.push({
                item: new Item(storeItem.objectId, {
                    ...utils.crushOb(item),
                    amount: 0,
                    price: storeItem.price
                }),
                amount: 0,
                price: storeItem.price
            });
        });
    });

    return rows;
}

function openMerchantTradeWindow(session, merchant) {
    const store = merchant.fetchPrivateStore && merchant.fetchPrivateStore();
    if (!store || !store.items || store.items.length === 0) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "This merchant is not trading right now." }));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    TradeService.refreshStorePrices(store, session.actor);
    store.revision = Math.max(1, Number(store.revision || 1));
    session.activeMerchantTrade = {
        merchant,
        store,
        revision: store.revision,
        prices: Object.fromEntries(TradeService.nativeStoreItems(store).map((line) => [Number(line.selfId), Number(line.price)]))
    };
    session.viewedPrivateStoreSeller = merchant;

    if (store.storeType === 1) {
        session.dataSendToMe(store.nativePlayerStore === true
            ? ServerResponse.privateStoreListSell(merchant, session.actor)
            : ServerResponse.purchaseList(
                merchantPurchaseItems(store),
                session.actor.backpack.fetchTotalAdena()
            ));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    if (store.storeType === 3) {
        const rows = merchantDemandRows(session.actor, store);
        session.activeMerchantTrade.saleQuotes = new Map(rows.map(row => [row.item.fetchId(),
            { selfId: row.item.fetchSelfId(), price: row.price, amount: row.amount }]));
        // Finish the interaction before opening WTB so the C4 client can move
        // while keeping the buyer targeted, as with manufacture windows.
        session.dataSendToMe(ServerResponse.actionFailed());
        session.dataSendToMe(ServerResponse.privateStoreListBuy(
            merchant,
            rows,
            session.actor.backpack.fetchTotalAdena()
        ));
    }
}

function privateStoreTitle(actor) {
    return actor.fetchPrivateStore?.()?.title || actor.fetchTitle() || '';
}

function sendPrivateStoreMessage(session, actor) {
    const storeType = actor.fetchPrivateStoreType?.();
    const title = privateStoreTitle(actor);
    if (storeType === 3) {
        session.dataSendToMe(ServerResponse.privateStoreBuyMsg(actor, title));
    } else if (storeType === 1) {
        session.dataSendToMe(ServerResponse.privateStoreMsg(actor, title));
    } else if (storeType === 5) {
        session.dataSendToMe(ServerResponse.recipeShopMsg(actor));
    }
}

function openManufactureWindow(session, crafter) {
    session.viewedPrivateStoreSeller = crafter;
    // C4 treats a manufacture list as an interaction, not a store-state update.
    // Finish that interaction before opening the list so selecting another target
    // is not blocked by the client after the window is closed.
    session.dataSendToMe(ServerResponse.actionFailed());
    session.dataSendToMe(ServerResponse.recipeShopSellList(crafter, session.actor));
}

function select(session, actor, data) {
    const Generics = invoke(path.actor);
    const moveGeneration = Number(actor.moveRequestGeneration || 0);
    const isCurrent = () => session.actor === actor
        && Number(actor.moveRequestGeneration || 0) === moveGeneration;
    // AI target refreshes are not client double-clicks. Combat planners
    // choose whether to cast, finish with a weapon, or hold their attack.
    const selectionOnly = session?.constructor?.name === 'BotSession'
        || String(session?.accountId || '').startsWith('bot_');
    if (selectionOnly && Number(actor.fetchDestId()) === Number(data.id)) return;

    if (actor.fetchId() === data.id) { // Click on self
        actor.setDestId(actor.fetchId());
        session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
        session.dataSendToMe(ServerResponse.relationChanged(actor));
        return;
    }

    const afkProjection = invoke('GameServer/AfkTrade/AfkTradeService').findProjection(data.id);
    if (afkProjection) {
        const merchant = afkProjection.actor;
        if (merchant.fetchId() !== actor.fetchDestId()) {
            actor.setDestId(merchant.fetchId());
            session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
            session.dataSendToMe(ServerResponse.relationChanged(merchant));
            return;
        }
        sendPrivateStoreMessage(session, merchant);
        openMerchantTradeWindow(session, merchant);
        return;
    }

    // Check BotManager sessions first (bots may not be in World.user.sessions)
    const BotManager = invoke('GameServer/Bot/BotManager');
    const botSession = BotManager.sessions.find(s => Number(s.actor?.fetchId()) === Number(data.id));

    if (botSession) {
        const user = botSession.actor;
        invoke('GameServer/Bot/BotAI').promoteForPlayerInteraction(botSession, 'player_selected', session);
        if (user.fetchId() !== actor.fetchDestId()) { // First click on bot
            actor.setDestId(user.fetchId());
            session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
            session.dataSendToMe(ServerResponse.relationChanged(user));
            return;
        }
        // Second click on bot
        if (user.fetchPrivateStoreType && user.fetchPrivateStoreType() !== 0) {
            utils.infoWarn('Select', 'Second click on bot "%s" with private store type %d. Plan: %s', user.fetchName(), user.fetchPrivateStoreType(), botSession.plan);
            session.viewedPrivateStoreSeller = user;
            const isMerchantBot = botSession.plan === 'merchant';
            if (user.fetchPrivateStoreType() === 5) {
                openManufactureWindow(session, user);
            } else if (isMerchantBot) {
                utils.infoSuccess('Select', 'Opening native merchant trade window for bot "%s"', user.fetchName());
                sendPrivateStoreMessage(session, user);
                openMerchantTradeWindow(session, user);
            } else if (user.fetchPrivateStoreType() === 1) {
                sendPrivateStoreMessage(session, user);
                session.dataSendToMe(ServerResponse.privateStoreListSell(user, session.actor));
            } else if (user.fetchPrivateStoreType() === 3) {
                sendPrivateStoreMessage(session, user);
                openMerchantTradeWindow(session, user);
            }
            return;
        }
        Generics.attackRequest(session, actor, data);
        return;
    }

    // Fallback to World lookups for non-bot entities
    World.fetchNpc(data.id).then((npc) => {
        if (session.actor !== actor) return;
        // Another AI pass can select this target while the lookup is pending.
        if (selectionOnly && Number(actor.fetchDestId()) === Number(npc.fetchId())) return;
        if (npc.fetchId() !== actor.fetchDestId()) { // First click on a Creature
            actor.setDestId(npc.fetchId());
            session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId(), actor.fetchLevel() - npc.fetchLevel()));
            actor.statusUpdateVitals(npc);
        }
        else { // Second click on same Creature
            if (!isCurrent()) return;
            if (npc.fetchIsSummon?.() === true && Number(npc.fetchOwnerId?.()) === Number(actor.fetchId())) {
                SummonControl.showStatusWindow(session, actor, npc);
                return;
            }

            Generics.attackRequest(session, actor, data);
        }
    }).catch(() => {
        World.fetchItem(data.id).then(() => {
            if (isCurrent()) Generics.pickupRequest(session, actor, data);
        }).catch(() => {
            World.fetchUser(data.id).then((user) => {
                if (session.actor !== actor) return;
                if (selectionOnly && Number(actor.fetchDestId()) === Number(user.fetchId())) return;
                if (user.fetchId() !== actor.fetchDestId()) { // First click on a User
                    actor.setDestId(user.fetchId());
                    session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
                    session.dataSendToMe(ServerResponse.relationChanged(user));
                }
                else { // Second click on same User
                    if (!isCurrent()) return;
                    if (user.fetchPrivateStoreType && user.fetchPrivateStoreType() !== 0) {
                        session.viewedPrivateStoreSeller = user;
                        if (user.fetchPrivateStoreType() === 1) {
                            sendPrivateStoreMessage(session, user);
                            session.dataSendToMe(ServerResponse.privateStoreListSell(user, session.actor));
                        } else if (user.fetchPrivateStoreType() === 3) {
                            sendPrivateStoreMessage(session, user);
                            openMerchantTradeWindow(session, user);
                        } else if (user.fetchPrivateStoreType() === 5) {
                            openManufactureWindow(session, user);
                        }
                        return;
                    }
                    Generics.attackRequest(session, actor, data);
                }
            }).catch(() => {
                if (!isCurrent()) return;
                // C4 keeps a clicked object's Action pending until the server
                // answers. A stale ground object must not lock client input.
                session.dataSendToMe(ServerResponse.actionFailed());
                session.dataSendToMe(ServerResponse.deleteOb(data.id));
                utils.infoWarn('GameServer', 'unknown World Id %d', data.id);
            });
        });
    });
}

module.exports = select;
