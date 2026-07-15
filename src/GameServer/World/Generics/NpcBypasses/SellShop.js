const ServerResponse = invoke('GameServer/Network/Response');

function sellRows(actor) {
    return actor.backpack.fetchItems()
        .filter((item) => !item.fetchEquipped() && item.fetchSelfId() !== 57)
        .map((item) => ({
            item,
            amount: item.fetchAmount(),
            price: Math.max(1, Math.floor(item.fetchPrice() * 0.5))
        }));
}

module.exports = function(session) {
    session.activeMerchantTrade = null;
    session.activeAdminShop = null;
    session.activeNpcShop = null;

    const rows = sellRows(session.actor);
    session.activeNpcSellShop = {
        npcSelfId: session.activeNpcTalk?.selfId,
        items: new Map(rows.map((row) => [row.item.fetchId(), {
            selfId: row.item.fetchSelfId(),
            price: row.price
        }]))
    };

    session.dataSendToMe(ServerResponse.sellList(
        rows,
        session.actor.backpack.fetchTotalAdena()
    ));
    session.dataSendToMe(ServerResponse.actionFailed());
};
