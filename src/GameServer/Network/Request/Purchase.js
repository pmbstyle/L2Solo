const World         = invoke('GameServer/World/World');
const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Item           = invoke('GameServer/Item/Item');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const LifeState      = invoke('GameServer/Bot/Population/BotLifeState');
const BotManager     = invoke('GameServer/Bot/BotManager');
const Cooldown       = invoke('GameServer/Bot/Population/Cooldown');
const GoalExecutor   = invoke('GameServer/Bot/Goals/GoalExecutor');

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

function purchase(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // List Id
        .readD(); // Count

    let list = [];

    for (let i = 0; i < packet.data[1]; i++) {
        packet
            .readD()
            .readD();

        list.push({ selfId: packet.data[2 + (i * 2)], amount: packet.data[3 + (i * 2)] });
    }

    consume(session, {
        listId: packet.data[0],
          list: list
    });
}

async function consume(session, data) {
    const trade = session.activeMerchantTrade;
    const store = trade && trade.store;
    const adminShop = session.activeAdminShop;

    if (store && store.storeType === 1) {
        try {
            const bought = [];
            let sellerSession = null;
            for (const item of data.list) {
                const result = await TradeService.buyFromStore(session.actor, store, item.selfId, item.amount);
                bought.push(result);
                sellerSession = BotManager.sessions.find((candidate) => candidate.actor === trade.merchant);
                if (sellerSession?.coldMarketState) {
                    const storeItem = store.items.find((entry) => Number(entry.selfId) === Number(item.selfId));
                    const updatedSeller = await LifeState.applyMarketSale(sellerSession.coldMarketState, {
                        selfId: item.selfId,
                        price: result.totalAdena / result.qty,
                        buyerCharacterId: session.actor.fetchId(),
                        storeItem
                    }, result.qty);
                    if (updatedSeller) sellerSession.coldMarketState = updatedSeller;
                }
            }

            if (bought.length > 0) {
                const detail = bought.map((item) => `${item.qty} ${item.name}`).join(', ');
                BotSocialMemory.recordTradeCompleted(session, trade.merchant, `bought ${detail}`);
            }

            session.dataSendToMe(ServerResponse.userInfo(session.actor));
            session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
            const soldOut = !store.items.some((item) => Number(item.count || 0) > 0);
            if (soldOut) {
                const returnState = sellerSession?.coldMarketState
                    ? GoalExecutor.finishMarketVisit(sellerSession.coldMarketState)
                    : null;
                if (returnState) {
                    await Cooldown.transitionToColdState(sellerSession, {
                        ...returnState,
                        stats: { ...(returnState.stats || {}), marketStore: null }
                    }, 'market_sold_out');
                }
                session.activeMerchantTrade = null;
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }
            session.dataSendToMe(ServerResponse.purchaseList(
                merchantPurchaseItems(store),
                session.actor.backpack.fetchTotalAdena()
            ));
        } catch (err) {
            utils.infoWarn('Purchase', 'merchant purchase error: %s', err.message || err);
            session.dataSendToMe(ServerResponse.actionFailed());
        }
        return;
    }

    if (adminShop) {
        const allowed = data.list.every((item) => adminShop.itemIds.has(item.selfId));
        if (!allowed) {
            session.activeAdminShop = null;
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        World.purchaseItems(session, data.list, { free: true });
        return;
    }

    if (session.activeNpcShop) {
        const allowed = data.list.every((item) => session.activeNpcShop.itemIds.has(item.selfId));
        if (!allowed) {
            session.activeNpcShop = null;
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        World.purchaseItems(session, data.list, { prices: session.activeNpcShop.prices });
        return;
    }

    World.purchaseItems(session, data.list);
}

module.exports = purchase;
