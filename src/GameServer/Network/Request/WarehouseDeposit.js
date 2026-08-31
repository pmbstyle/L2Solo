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

module.exports = async function warehouseDeposit(session, buffer) {
    try {
        const requested = lines(buffer);
        if (!requested) throw new Error('malformed warehouse deposit packet');
        const active = session.activeWarehouse;
        if (!active || active.mode !== 'deposit') throw new Error('warehouse deposit window is not active');
        await (active.type === 'clan' ? ClanWarehouse : Warehouse).deposit(session, requested);
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
    } catch (error) {
        utils.infoWarn('Warehouse', 'deposit rejected: %s', error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    }
};
