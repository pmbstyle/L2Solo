const ReceivePacket = invoke('Packet/Receive');
const Inventory = invoke('GameServer/Pets/PetInventory');
const Response = invoke('GameServer/Network/Response');
function handler(action, size) {
    return (session, buffer) => {
        if (!session.actor || !buffer || buffer.length < size) return;
        const packet = new ReceivePacket(buffer);
        if (action === 'rename') packet.readS();
        else { packet.readD(); if (size === 9) packet.readD(); }
        const [id, amount] = packet.data;
        let work;
        if (action === 'rename') work = Inventory.rename(session, id);
        else if (action === 'use') work = Inventory.use(session, id);
        else work = Inventory.transfer(session, id, amount, action);
        Promise.resolve(work).catch(() => session.dataSendToMe?.(Response.actionFailed()));
    };
}
module.exports = { rename: handler('rename', 3), use: handler('use', 5), deposit: handler('deposit', 9), withdraw: handler('withdraw', 9) };
