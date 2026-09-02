const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const Sell = invoke('GameServer/Network/Request/Sell');

// C4 RequestPrivateStoreSell (0x96): a player sells inventory to a seated
// private buyer. Its row format is not the generic NPC Sell request format.
function privateStoreSell(session, buffer) {
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

    if (!Number.isSafeInteger(count) || count < 1 || count > 100 ||
        buffer.length < 9 + (count * 20) ||
        !trade || Number(trade.merchant?.fetchId?.()) !== merchantId || store?.storeType !== 3) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve();
    }

    const list = [];
    for (let i = 0; i < count; i++) {
        packet.readD().readD().readH().readH().readD().readD();
        list.push({
            objectId: Number(packet.data[2 + (i * 6)]),
            selfId: Number(packet.data[3 + (i * 6)]),
            amount: Number(packet.data[6 + (i * 6)]),
            price: Number(packet.data[7 + (i * 6)])
        });
    }

    if (store.afkTrade === true) {
        return list.reduce((pending, row) => pending.then(async () => {
            const projection = invoke('GameServer/AfkTrade/AfkTradeService').findProjection(merchantId);
            const activeStore = projection?.actor?.fetchPrivateStore?.() || store;
            const line = (activeStore.items || []).find((entry) => Number(entry.selfId) === row.selfId && Number(entry.count) > 0);
            const inventoryItem = session.actor.backpack.fetchItemRaw(row.objectId);
            if (!line || !inventoryItem || inventoryItem.fetchEquipped() || inventoryItem.fetchSelfId() !== row.selfId
                || !Number.isSafeInteger(row.amount) || row.amount < 1 || row.amount > inventoryItem.fetchAmount()
                || row.amount > Number(line.count) || Number(row.price) !== Number(line.price)) {
                throw new Error('afk_trade_demand_changed');
            }
            await invoke('GameServer/AfkTrade/AfkTradeService').sellToShop(
                session.actor.fetchId(),
                activeStore,
                row.selfId,
                row.amount,
                { objectId: row.objectId, expectedPrice: row.price }
            );
        }), Promise.resolve()).catch((error) => {
            utils.infoWarn('AfkTrade', 'private-store sale failed: %s', error.message);
            session.dataSendToMe(ServerResponse.actionFailed());
        });
    }

    return Sell.consumeMerchant(session, list, { native: true });
}

module.exports = privateStoreSell;
