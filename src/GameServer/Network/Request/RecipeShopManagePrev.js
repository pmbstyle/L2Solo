const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');

module.exports = (session) => ManufactureShop.previous(session);
