const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');

function recipeBookOpen(session, buffer) {
    const packet = new ReceivePacket(buffer);
    packet.readD();
    const dwarven = Number(packet.data[0]) === 0;
    const actor = session?.actor;
    if (!actor || Number(actor.fetchPrivateStoreType?.()) > 0) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return;
    }

    const craftLevel = dwarven
        ? actor.backpack?.fetchDwarvenCraftLevel?.(actor)
        : actor.backpack?.fetchCommonCraftLevel?.(actor);
    if (!(Number(craftLevel) > 0)) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return;
    }

    session.dataSendToMe(ServerResponse.recipeBookItemList(actor, dwarven));
}

module.exports = recipeBookOpen;
