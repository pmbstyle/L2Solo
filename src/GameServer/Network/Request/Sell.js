const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Database       = invoke('Database');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const Mutations = require('../../Inventory/InventoryMutationQueue');
const InventoryLimits = require('../../Inventory/InventoryLimits');
const Item = invoke('GameServer/Item/Item');

// Invalid or stale client requests are normal refusals; persistence failures
// still need an error in the server log.
class NpcSaleRejected extends Error {}

function merchantSellRows(actor, store) {
    TradeService.refreshStorePrices(store, actor);
    const nativeItems = TradeService.nativeStoreItems(store);
    return actor.backpack.fetchItems()
        .filter(TradeService.isSellableInventoryItem)
        .map((item) => {
            const wanted = nativeItems.find((storeItem) => storeItem.selfId === item.fetchSelfId() && storeItem.count > 0);
            if (!wanted) return null;

            const quote = TradeService.storeSaleQuote(store, wanted, actor, item);
            return {
                item,
                amount: Math.min(item.fetchAmount(), quote.count),
                price: quote.price
            };
        })
        .filter((row) => row && row.amount > 0);
}

function sell(session, buffer) {
    const count = buffer.length >= 9 ? buffer.readInt32LE(5) : -1;
    if (count < 1 || count > InventoryLimits.MAX_CAPACITY || buffer.length !== 9 + count * 12) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // List Id
        .readD(); // Count

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

    // A shop on the board trades only through the board (PrivateStoreSell):
    // its window's store is a projection of the record.
    if (store?.afkTrade === true) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }
    if (!store || store.storeType !== 3) {
        return sellToNpcShop(session, list);
    }

    const sold = [];
    let socialRecorded = false;
    // One social event for the lines that completed, whether the list ended
    // whole or a later line failed; never one event per line.
    const recordSold = () => {
        if (socialRecorded || sold.length === 0) return;
        socialRecorded = true;
        const detail = sold.map((item) => `${item.qty} ${item.name}`).join(', ');
        BotSocialMemory.recordTradeCompleted(session, trade.merchant, `sold ${detail}`);
    };
    try {
        TradeService.refreshStorePrices(store, session.actor);
        const nativeItems = TradeService.nativeStoreItems(store);
        const objectIds = new Set();
        const requested = list.map((line) => {
            const item = line.objectId ? TradeService.sellableCopy(session.actor, line.selfId, line.objectId) : null;
            const wanted = nativeItems.find((storeItem) => storeItem.selfId === line.selfId && storeItem.count > 0);
            const amount = Number(line.amount);
            const quote = item && wanted ? TradeService.storeSaleQuote(store, wanted, session.actor, item) : null;
            const saved = trade.saleQuotes?.get(item?.fetchId());
            const expectedUnitPrice = line.price ?? saved?.price ?? trade.prices?.[line.selfId] ?? quote?.price;
            const matchesPrice = Number(expectedUnitPrice) === Number(quote?.price);
            if (!item || !wanted ||
                !Number.isSafeInteger(amount) || amount < 1 || amount > item.fetchAmount() || amount > quote.count || !matchesPrice ||
                (saved && (saved.selfId !== line.selfId || amount > saved.amount || Number(expectedUnitPrice) !== saved.price)) ||
                objectIds.has(item.fetchId())) return null;
            objectIds.add(item.fetchId());
            return { item, amount, expectedUnitPrice };
        });
        if (requested.length !== list.length || requested.some((line) => line === null)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        for (const line of requested) {
            const result = await TradeService.sellToStore(session.actor, store, line.item.fetchSelfId(), line.amount, {
                objectId: line.item.fetchId(),
                buyerActor: trade.merchant,
                expectedUnitPrice: line.expectedUnitPrice
            });
            sold.push(result);
            const recordedQty = result.npcQty ?? result.qty;
            if (recordedQty > 0) MarketTelemetry.recordTrade({
                channel: 'wtb',
                sourceType: 'private_buy_store_player_sale',
                selfId: line.item.fetchSelfId(),
                itemName: result.name,
                quantity: recordedQty,
                unitPrice: (result.npcAdena ?? result.totalAdena) / recordedQty,
                town: store.town || trade.merchant?.session?.coldMarketState?.currentRegion,
                sellerCharacterId: session.actor.fetchId(),
                sellerName: session.actor.fetchName(),
                buyerCharacterId: trade.merchant?.fetchId?.(),
                buyerName: trade.merchant?.fetchName?.()
            });
        }

        recordSold();

        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        const soldOut = !store.items.some((item) => Number(item.count || 0) > 0);
        if (soldOut) {
            invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService').closeSoldOutStore(trade.merchant, store);
            session.activeMerchantTrade = null;
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }
        const rows = merchantSellRows(session.actor, store);
        trade.prices = Object.fromEntries(TradeService.nativeStoreItems(store).map(line => [Number(line.selfId), Number(line.price)]));
        trade.saleQuotes = new Map(rows.map(row => [row.item.fetchId(),
            { selfId: row.item.fetchSelfId(), price: row.price, amount: row.amount }]));
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
        recordSold();
    }
}

function sellToNpcShop(session, list) {
    const actor = session.actor;
    const backpack = actor?.backpack;
    const shop = session.activeNpcSellShop;
    if (!shop || !backpack) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    return Mutations.run(backpack, async () => {
        try {
            const seen = new Set();
            if (!Array.isArray(list) || !list.length || list.length > InventoryLimits.MAX_CAPACITY) throw new NpcSaleRejected('invalid NPC sale');
            const requested = list.map(line => {
                const item = backpack.fetchItems().find(ob => ob.fetchId() === line.objectId);
                const offered = shop.items.get(line.objectId);
                const amount = Number(line.amount);
                if (!NpcSellRules.canSell(item) || !offered || seen.has(line.objectId)
                    || item.fetchSelfId() !== line.selfId || item.fetchSelfId() !== offered.selfId
                    || !Number.isSafeInteger(amount) || amount < 1 || amount > item.fetchAmount()
                    || !Number.isSafeInteger(offered.price) || offered.price < 0) throw new NpcSaleRejected('NPC sale item changed');
                seen.add(line.objectId);
                return { objectId: line.objectId, selfId: line.selfId, amount, price: offered.price,
                    expectedAmount: item.fetchAmount(), item };
            });
            const validate = () => {
                if (session.actor !== actor || session.activeNpcSellShop !== shop) throw new NpcSaleRejected('NPC sale window changed');
                for (const line of requested) {
                    if (!backpack.fetchItems().includes(line.item) || !NpcSellRules.canSell(line.item)
                        || line.item.fetchAmount() !== line.expectedAmount
                        || shop.items.get(line.objectId)?.price !== line.price) throw new NpcSaleRejected('NPC sale item changed');
                }
            };
            const result = await Database.sellItemsToNpc(actor.fetchId(), requested.map(({ objectId, selfId, amount, price, expectedAmount }) => ({ objectId, selfId, amount, price, expectedAmount })), validate);
            // The transaction committed the entire batch and its payout. Publish
            // only those committed amounts, never a pre-await balance plus price.
            for (const sold of result.sold) {
                const item = requested.find(line => line.objectId === sold.objectId).item;
                if (sold.amount) item.setAmount(sold.amount);
                else backpack.items = backpack.items.filter(candidate => candidate !== item);
                backpack.onInventoryChange?.(item.fetchSelfId());
            }
            if (result.adena) {
                const adena = backpack.fetchItems().find(item => item.fetchId() === Number(result.adena.id));
                if (adena) adena.setAmount(Number(result.adena.amount));
                else backpack.insertItem(Number(result.adena.id), 57, { amount: Number(result.adena.amount) });
            }
            backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
            Item.bindInventory(backpack);
        } catch (err) {
            if (!(err instanceof NpcSaleRejected)) utils.infoWarn('Sell', 'NPC shop sell error: %s', err.message || err);
            if (session.actor === actor) session.dataSendToMe(ServerResponse.actionFailed());
        }

        if (session.actor !== actor || session.activeNpcSellShop !== shop) return;
        const rows = NpcSellRules.rows(actor);
        shop.items = new Map(rows.map(row => [row.item.fetchId(), {
            selfId: row.item.fetchSelfId(), price: row.price
        }]));
        session.dataSendToMe(ServerResponse.userInfo(actor));
        session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.sellList(rows, backpack.fetchTotalAdena()));
    });
}

module.exports = sell;
module.exports.consumeMerchant = consumeMerchant;
module.exports.merchantSellRows = merchantSellRows;
