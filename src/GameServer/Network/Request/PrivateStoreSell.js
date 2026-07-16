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

    return Sell.consumeMerchant(session, list, { native: true });
}

module.exports = privateStoreSell;
