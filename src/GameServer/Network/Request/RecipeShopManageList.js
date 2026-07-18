const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');
module.exports = (session) => { if (!ManufactureShop.open(session)) session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed()); };
