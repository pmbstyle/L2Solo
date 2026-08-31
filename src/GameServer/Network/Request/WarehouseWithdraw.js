const ServerResponse = invoke('GameServer/Network/Response');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const ClanWarehouse = invoke('GameServer/Warehouse/ClanWarehouse');

function lines(buffer) {
    if (buffer.length < 5) return null;
    const count = buffer.readInt32LE(1);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100 || buffer.length !== 5 + (count * 8)) return null;
    return Array.from({ length: count }, (_, index) => ({
        objectId: buffer.readInt32LE(5 + (index * 8)),
        amount: buffer.readInt32LE(9 + (index * 8))
    }));
}

module.exports = async function warehouseWithdraw(session, buffer) {
    try {
        const requested = lines(buffer);
        if (!requested) throw new Error('malformed warehouse withdrawal packet');
        const active = session.activeWarehouse;
        if (!active || active.mode !== 'withdraw') throw new Error('warehouse withdrawal window is not active');
        const clan = active.type === 'clan';
        const items = await (clan ? ClanWarehouse : Warehouse).withdraw(session, requested);
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.wareHouseWithdrawalList(
            items, session.actor.backpack.fetchTotalAdena(), clan ? 2 : 1
        ));
    } catch (error) {
        utils.infoWarn('Warehouse', 'withdraw rejected: %s', error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    }
};
