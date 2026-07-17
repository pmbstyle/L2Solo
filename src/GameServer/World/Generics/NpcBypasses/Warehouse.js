const ServerResponse = invoke('GameServer/Network/Response');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');

module.exports = async function warehouse(session, parts) {
    if (!Warehouse.isWarehouseNpc(session)) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const mode = parts[1];
    session.activeNpcShop = null;
    session.activeNpcSellShop = null;
    session.activeWarehouse = true;

    if (mode === 'deposit') {
        session.dataSendToMe(ServerResponse.wareHouseDepositList(
            session.actor.backpack.fetchItems().filter((item) => !item.fetchEquipped()),
            session.actor.backpack.fetchTotalAdena()
        ));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    if (mode === 'withdraw') {
        const items = await Warehouse.list(session.actor.fetchId());
        session.dataSendToMe(ServerResponse.wareHouseWithdrawalList(
            items, session.actor.backpack.fetchTotalAdena()
        ));
        session.dataSendToMe(ServerResponse.actionFailed());
    }
};
