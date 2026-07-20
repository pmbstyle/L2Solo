const ServerResponse = invoke('GameServer/Network/Response');
const C4GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');

module.exports = function gatekeeperTeleport(session, parts) {
    const actor = session?.actor;
    const destination = C4GatekeeperTeleports.destination(session?.activeNpcTalk?.selfId, Number(parts?.[1]));
    if (!actor || !destination) return session?.dataSendToMe?.(ServerResponse.actionFailed());

    const adena = actor.backpack?.fetchItemFromSelfId?.(57);
    if (destination.price > 0 && (!adena || adena.fetchAmount() < destination.price)) {
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: 'You do not have enough Adena.' }));
        return session.dataSendToMe(ServerResponse.actionFailed());
    }

    const teleport = () => invoke(path.actor).teleportTo(session, actor, destination);
    if (destination.price > 0) actor.backpack.deleteItem(session, adena.fetchId(), destination.price, teleport);
    else teleport();
};
