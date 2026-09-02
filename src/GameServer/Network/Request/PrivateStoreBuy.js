const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');

// C4 RequestPrivateStoreBuy (0x79): buy one or more rows from a player sale
// store. The object id belongs to the seller's advertised inventory lot.
function privateStoreBuy(session, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 9) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve();
    }
    const packet = new ReceivePacket(buffer);
    packet.readD().readD();
    const merchantId = Number(packet.data[0]);
    const count = Number(packet.data[1]);
    const trade = session.activeMerchantTrade;
    const store = trade?.store;
    if (!Number.isSafeInteger(count) || count < 1 || count > 4
        || buffer.length < 9 + count * 12
        || !trade || Number(trade.merchant?.fetchId?.()) !== merchantId
        || Number(store?.storeType) !== 1 || store.afkTrade !== true) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve();
    }

    const rows = [];
    for (let index = 0; index < count; index += 1) {
        packet.readD().readD().readD();
        rows.push({
            objectId: Number(packet.data[2 + index * 3]),
            amount: Number(packet.data[3 + index * 3]),
            price: Number(packet.data[4 + index * 3])
        });
    }
    if (store.packageSale === true) {
        const completePackage = rows.length === store.items.length && rows.every((row) => {
            const line = store.items.find((entry) => Number(entry.objectId) === row.objectId);
            return line && Number(row.amount) === Number(line.count) && Number(row.price) === Number(line.price);
        });
        if (!completePackage) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return Promise.resolve();
        }
    }

    return rows.reduce((pending, row) => pending.then(async () => {
        const projection = invoke('GameServer/AfkTrade/AfkTradeService').findProjection(merchantId)
            || invoke('GameServer/AfkTrade/AfkTradeService').findProjection(trade.merchant.fetchId());
        const activeStore = projection?.actor?.fetchPrivateStore?.() || store;
        const line = (activeStore.items || []).find((entry) => Number(entry.objectId) === row.objectId);
        if (!line || !Number.isSafeInteger(row.amount) || row.amount < 1 || row.amount > Number(line.count)
            || Number(row.price) !== Number(line.price)) throw new Error('afk_trade_stock_changed');
        await invoke('GameServer/AfkTrade/AfkTradeService').buyFromShop(
            session.actor.fetchId(),
            activeStore,
            line.selfId,
            row.amount,
            { lineId: line.afkTradeLineId, expectedPrice: row.price }
        );
    }), Promise.resolve()).catch((error) => {
        utils.infoWarn('AfkTrade', 'private-store purchase failed: %s', error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    });
}

module.exports = privateStoreBuy;
