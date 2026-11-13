const World         = invoke('GameServer/World/World');
const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotManager     = invoke('GameServer/Bot/BotManager');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const WireD = invoke('Packet/WireD');
const merchantPurchaseItems = invoke('GameServer/Network/MerchantPurchaseItems');

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

    // Server.js drops the connection when this Promise rejects; left
    // unreturned, the rejection would end the process.
    return consume(session, {
        listId: packet.data[0],
          list: list
    });
}

async function consume(session, data) {
    const trade = session.activeMerchantTrade;
    const store = trade && trade.store;
    const adminShop = session.activeAdminShop;

    // A shop on the board trades only through the board (PrivateStoreBuy):
    // its window's store is a projection of the record.
    if (store?.afkTrade === true) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }
    if (store && store.storeType === 1) {
        const bought = [];
        let socialRecorded = false;
        // One social event for the lines that completed, whether the list ended
        // whole or a later line failed; never one event per line.
        const recordBought = () => {
            if (socialRecorded || bought.length === 0) return;
            socialRecorded = true;
            const detail = bought.map((item) => `${item.qty} ${item.name}`).join(', ');
            BotSocialMemory.recordTradeCompleted(session, trade.merchant, `bought ${detail}`);
        };
        try {
            if (store.repricing === true || Number(trade.revision || 1) !== Number(store.revision || 1)) {
                throw new Error("Store listing changed.");
            }
            const sellerSession = BotManager.sessions.find((candidate) => candidate.actor === trade.merchant);
            for (const item of data.list) {
                const quote = trade.prices?.[Number(item.selfId)];
                if (!WireD.isRepresentable(quote)) throw new Error('Store item has no native quote.');
                const result = await TradeService.buyFromStore(session.actor, store, item.selfId, item.amount, {
                    expectedRevision: trade.revision,
                    expectedUnitPrice: quote
                });
                bought.push(result);
                MarketTelemetry.recordTrade({
                    channel: 'wts',
                    sourceType: 'private_store_player_purchase',
                    selfId: item.selfId,
                    itemName: result.name,
                    quantity: result.qty,
                    unitPrice: result.qty ? result.totalAdena / result.qty : 0,
                    town: store.town || sellerSession?.coldMarketState?.currentRegion,
                    sellerCharacterId: trade.merchant?.fetchId?.(),
                    sellerName: trade.merchant?.fetchName?.(),
                    buyerCharacterId: session.actor.fetchId(),
                    buyerName: session.actor.fetchName()
                });
            }

            recordBought();

            session.dataSendToMe(ServerResponse.userInfo(session.actor));
            session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
            const soldOut = !store.items.some((item) => Number(item.count || 0) > 0);
            if (soldOut) {
                session.activeMerchantTrade = null;
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }
            session.dataSendToMe(ServerResponse.purchaseList(
                merchantPurchaseItems(store, { refresh: true, actor: session.actor }),
                session.actor.backpack.fetchTotalAdena()
            ));
            trade.prices = Object.fromEntries(TradeService.nativeStoreItems(store).map(line => [Number(line.selfId), Number(line.price)]));
        } catch (err) {
            utils.infoWarn('Purchase', 'merchant purchase error: %s', err.message || err);
            if (store.repricing === true || Number(trade.revision || 1) !== Number(store.revision || 1) || /changed/i.test(String(err.message || err))) {
                session.activeMerchantTrade = null;
                session.viewedPrivateStoreSeller = null;
            }
            session.dataSendToMe(ServerResponse.actionFailed());
            recordBought();
        }
        return;
    }

    // An NPC list line must ask for a whole number of items, at least one.
    if (!data.list.every((item) => Number.isSafeInteger(item.amount) && item.amount >= 1)) {
        session.dataSendToMe(ServerResponse.actionFailed());
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
