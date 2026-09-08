const ServerResponse = invoke('GameServer/Network/Response');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');

module.exports = function(session) {
    session.activeMerchantTrade = null;
    session.activeAdminShop = null;
    session.activeNpcShop = null;

    const rows = NpcSellRules.rows(session.actor);
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
