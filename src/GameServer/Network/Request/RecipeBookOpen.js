const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');

function openRecipeBook(session, dwarven) {
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

function recipeBookOpen(session, buffer) {
    const packet = new ReceivePacket(buffer);
    packet.readD();
    openRecipeBook(session, Number(packet.data[0]) === 0);
}

recipeBookOpen.open = openRecipeBook;

module.exports = recipeBookOpen;
