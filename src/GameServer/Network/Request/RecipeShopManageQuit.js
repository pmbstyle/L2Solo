const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');
const ServerResponse = invoke('GameServer/Network/Response');

module.exports = (session) => {
    const actor = session?.actor;
    if (!actor || Number(actor.fetchPrivateStoreType?.()) !== ManufactureShop.MANUFACTURE_MANAGE) return;
    actor.setPrivateStoreType(0);
    session.dataSendToMeAndOthers?.(ServerResponse.userInfo(actor), actor);
    session.dataSendToMeAndOthers?.(ServerResponse.charInfo(actor), actor);
};
