const ServerResponse = invoke('GameServer/Network/Response');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const ClanWarehouse = invoke('GameServer/Warehouse/ClanWarehouse');

module.exports = async function warehouse(session, parts) {
    if (!Warehouse.isWarehouseNpc(session)) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const mode = parts[1];
    session.activeNpcShop = null;
    session.activeNpcSellShop = null;
    if (mode === 'clan-deposit' || mode === 'clan-withdraw') {
        try {
            const clan = ClanWarehouse.clanFor(session);
            const operation = mode === 'clan-deposit' ? 'deposit' : 'withdraw';
            if (operation === 'withdraw' && !ClanWarehouse.canView(session, clan)) {
                throw new Error('clan warehouse privilege is required');
            }
            session.activeWarehouse = { type: 'clan', mode: operation, clanId: clan.id };
            const items = operation === 'deposit'
                ? session.actor.backpack.fetchItems().filter((item) => !item.fetchEquipped())
                : await ClanWarehouse.list(clan.id);
            session.dataSendToMe(operation === 'deposit'
                ? ServerResponse.wareHouseDepositList(items, session.actor.backpack.fetchTotalAdena(), 2)
                : ServerResponse.wareHouseWithdrawalList(items, session.actor.backpack.fetchTotalAdena(), 2));
        } catch (error) {
            session.activeWarehouse = null;
            utils.infoWarn('Warehouse', 'clan window rejected: %s', error.message);
        }
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    session.activeWarehouse = { type: 'personal', mode };

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
