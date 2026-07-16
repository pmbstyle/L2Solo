const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Database       = invoke('Database');

function merchantSellRows(actor, store) {
    return actor.backpack.fetchItems()
        .filter((item) => !item.fetchEquipped() && item.fetchSelfId() !== 57)
        .map((item) => {
            const wanted = store.items.find((storeItem) => storeItem.selfId === item.fetchSelfId() && storeItem.count > 0);
            if (!wanted) return null;

            return {
                item,
                amount: Math.min(item.fetchAmount(), wanted.count),
                price: wanted.price
            };
        })
        .filter((row) => row && row.amount > 0);
}

function npcSellRows(actor) {
    return actor.backpack.fetchItems()
        .filter((item) => !item.fetchEquipped() && item.fetchSelfId() !== 57)
        .map((item) => ({
            item,
            amount: item.fetchAmount(),
            price: Math.max(1, Math.floor(item.fetchPrice() * 0.5))
        }));
}

function sell(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // List Id
        .readD(); // Count

    const count = packet.data[1];
    const list = [];

    for (let i = 0; i < count; i++) {
        packet
            .readD()
            .readD()
            .readD();

        list.push({
            objectId: packet.data[2 + (i * 3)],
            selfId: packet.data[3 + (i * 3)],
            amount: packet.data[4 + (i * 3)]
        });
    }

    return consumeMerchant(session, list);
}

async function consumeMerchant(session, list, { native = false } = {}) {
    const trade = session.activeMerchantTrade;
    const store = trade && trade.store;

    if (!store || store.storeType !== 3) {
        return sellToNpcShop(session, list);
    }

    try {
        const sold = [];
        const objectIds = new Set();
        const requested = list.map((line) => {
            const item = session.actor.backpack.fetchItems().find((ob) => ob.fetchId() === line.objectId);
            const wanted = store.items.find((storeItem) => storeItem.selfId === line.selfId && storeItem.count > 0);
            const amount = Number(line.amount);
            const matchesPrice = line.price === undefined || Number(line.price) === Number(wanted?.price);
            if (!item || !wanted || item.fetchEquipped() || item.fetchSelfId() === 57 || item.fetchSelfId() !== line.selfId ||
                !Number.isSafeInteger(amount) || amount < 1 || amount > item.fetchAmount() || amount > wanted.count || !matchesPrice ||
                objectIds.has(item.fetchId())) return null;
            objectIds.add(item.fetchId());
            return { item, amount };
        });
        if (requested.length !== list.length || requested.some((line) => line === null)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        for (const line of requested) {
            sold.push(await TradeService.sellToStore(session.actor, store, line.item.fetchSelfId(), line.amount));
        }

        if (sold.length > 0) {
            const detail = sold.map((item) => `${item.qty} ${item.name}`).join(', ');
            BotSocialMemory.recordTradeCompleted(session, trade.merchant, `sold ${detail}`);
        }

        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        const soldOut = !store.items.some((item) => Number(item.count || 0) > 0);
        if (soldOut) {
            trade.merchant.setPrivateStoreType(0);
            trade.merchant.setPrivateStore({ ...store, items: [] });
            trade.merchant.session?.dataSendToOthers?.(ServerResponse.charInfo(trade.merchant), trade.merchant);
            session.activeMerchantTrade = null;
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }
        const rows = merchantSellRows(session.actor, store);
        if (native) {
            session.dataSendToMe(ServerResponse.privateStoreListBuy(
                trade.merchant,
                rows,
                session.actor.backpack.fetchTotalAdena()
            ));
        } else {
            session.dataSendToMe(ServerResponse.sellList(rows, session.actor.backpack.fetchTotalAdena()));
        }
    } catch (err) {
        utils.infoWarn('Sell', 'merchant sell error: %s', err.message || err);
        session.dataSendToMe(ServerResponse.actionFailed());
    }
}

async function sellToNpcShop(session, list) {
    const shop = session.activeNpcSellShop;
    if (!shop) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    try {
        const sold = [];
        for (const line of list) {
            const item = session.actor.backpack.fetchItems().find((ob) => ob.fetchId() === line.objectId);
            const offered = shop.items.get(line.objectId);
            const amount = Number(line.amount);
            if (!item || !offered || item.fetchEquipped() || item.fetchSelfId() === 57 ||
                item.fetchSelfId() !== line.selfId || item.fetchSelfId() !== offered.selfId ||
                !Number.isSafeInteger(amount) || amount < 1 || amount > item.fetchAmount()) continue;

            const payout = offered.price * amount;
            if (!Number.isSafeInteger(payout) || payout < 0) continue;

            if (amount === item.fetchAmount()) {
                await Database.deleteItem(session.actor.fetchId(), item.fetchId());
                session.actor.backpack.items = session.actor.backpack.items.filter((ob) => ob.fetchId() !== item.fetchId());
            } else {
                await Database.updateItemAmount(session.actor.fetchId(), item.fetchId(), item.fetchAmount() - amount);
                item.setAmount(item.fetchAmount() - amount);
            }
            sold.push({ payout });
        }

        const payout = sold.reduce((total, line) => total + line.payout, 0);
        if (payout > 0) {
            const backpack = session.actor.backpack;
            const adena = backpack.fetchItemFromSelfId(57);
            if (adena) {
                const total = adena.fetchAmount() + payout;
                await Database.updateItemAmount(session.actor.fetchId(), adena.fetchId(), total);
                adena.setAmount(total);
            } else {
                const packet = await Database.setItem(session.actor.fetchId(), {
                    selfId: 57,
                    name: 'Adena',
                    amount: payout,
                    equipped: false,
                    slot: 0
                });
                backpack.insertItem(Number(packet.insertId), 57, { amount: payout });
            }
        }

        const rows = npcSellRows(session.actor);
        shop.items = new Map(rows.map((row) => [row.item.fetchId(), {
            selfId: row.item.fetchSelfId(),
            price: row.price
        }]));

        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.sellList(
            rows,
            session.actor.backpack.fetchTotalAdena()
        ));
    } catch (err) {
        utils.infoWarn('Sell', 'NPC shop sell error: %s', err.message || err);
        session.dataSendToMe(ServerResponse.actionFailed());
    }
}

module.exports = sell;
module.exports.consumeMerchant = consumeMerchant;
