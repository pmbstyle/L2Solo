const ServerResponse = invoke('GameServer/Network/Response');
const World          = invoke('GameServer/World/World');
const DataCache      = invoke('GameServer/DataCache');
const Item           = invoke('GameServer/Item/Item');
const SummonControl  = invoke('GameServer/Npc/SummonControl');

function merchantPurchaseItems(store) {
    const items = [];

    store.items.forEach((storeItem) => {
        DataCache.fetchItemFromSelfId(storeItem.selfId, (item) => {
            items.push(new Item(storeItem.objectId, {
                ...utils.crushOb(item),
                amount: storeItem.count,
                price: storeItem.price
            }));
        });
    });

    return items;
}

function merchantDemandRows(actor, store) {
    const rows = [];

    store.items.forEach((storeItem) => {
        const inventoryItem = actor.backpack.fetchItems().find((item) => (
            item.fetchSelfId() === storeItem.selfId &&
            !item.fetchEquipped() &&
            item.fetchSelfId() !== 57
        ));

        if (inventoryItem) {
            rows.push({
                item: inventoryItem,
                amount: Math.min(inventoryItem.fetchAmount(), storeItem.count),
                price: storeItem.price
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

    session.activeMerchantTrade = { merchant, store };
    session.viewedPrivateStoreSeller = merchant;

    if (store.storeType === 1) {
        session.dataSendToMe(ServerResponse.purchaseList(
            merchantPurchaseItems(store),
            session.actor.backpack.fetchTotalAdena()
        ));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    if (store.storeType === 3) {
        session.dataSendToMe(ServerResponse.sellList(
            merchantDemandRows(session.actor, store),
            session.actor.backpack.fetchTotalAdena()
        ));
        session.dataSendToMe(ServerResponse.actionFailed());
    }
}

function select(session, actor, data) {
    const Generics = invoke(path.actor);

    if (actor.fetchId() === data.id) { // Click on self
        actor.setDestId(actor.fetchId());
        session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
        session.dataSendToMe(ServerResponse.relationChanged(actor));
        return;
    }

    // Check BotManager sessions first (bots may not be in World.user.sessions)
    const BotManager = invoke('GameServer/Bot/BotManager');
    const botSession = BotManager.sessions.find(s => Number(s.actor?.fetchId()) === Number(data.id));

    if (botSession) {
        const user = botSession.actor;
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
            if (isMerchantBot) {
                utils.infoSuccess('Select', 'Opening native merchant trade window for bot "%s"', user.fetchName());
                openMerchantTradeWindow(session, user);
            } else if (user.fetchPrivateStoreType() === 1) {
                session.dataSendToMe(ServerResponse.privateStoreMsg(user, user.fetchTitle()));
                session.dataSendToMe(ServerResponse.privateStoreListSell(user, session.actor));
            } else if (user.fetchPrivateStoreType() === 3) {
                openMerchantTradeWindow(session, user);
            }
            return;
        }
        Generics.attackRequest(session, actor, data);
        return;
    }

    // Fallback to World lookups for non-bot entities
    World.fetchNpc(data.id).then((npc) => {
        if (npc.fetchId() !== actor.fetchDestId()) { // First click on a Creature
            actor.setDestId(npc.fetchId());
            npc.setLocZ(actor.fetchLocZ()); // TODO: Remove, uber hack...
            session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId(), actor.fetchLevel() - npc.fetchLevel()));
            actor.statusUpdateVitals(npc);
        }
        else { // Second click on same Creature
            if (npc.fetchIsSummon?.() === true && Number(npc.fetchOwnerId?.()) === Number(actor.fetchId())) {
                SummonControl.showStatusWindow(session, actor, npc);
                return;
            }

            Generics.attackRequest(session, actor, data);
        }
    }).catch(() => {
        World.fetchItem(data.id).then(() => {
            Generics.pickupRequest(session, actor, data);
        }).catch(() => {
            World.fetchUser(data.id).then((user) => {
                if (user.fetchId() !== actor.fetchDestId()) { // First click on a User
                    actor.setDestId(user.fetchId());
                    session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
                    session.dataSendToMe(ServerResponse.relationChanged(user));
                }
                else { // Second click on same User
                    if (user.fetchPrivateStoreType && user.fetchPrivateStoreType() !== 0) {
                        session.viewedPrivateStoreSeller = user;
                        if (user.fetchPrivateStoreType() === 1) {
                            session.dataSendToMe(ServerResponse.privateStoreMsg(user, user.fetchTitle()));
                            session.dataSendToMe(ServerResponse.privateStoreListSell(user, session.actor));
                        } else if (user.fetchPrivateStoreType() === 3) {
                            openMerchantTradeWindow(session, user);
                        }
                        return;
                    }
                    Generics.attackRequest(session, actor, data);
                }
            }).catch(() => {
                utils.infoWarn('GameServer', 'unknown World Id %d', data.id);
            });
        });
    });
}

module.exports = select;
