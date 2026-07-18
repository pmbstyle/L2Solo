const SendPacket = invoke('Packet/Send');

// C4 RecipeShopSellList: the customer sees the dwarf's MP, own Adena, and advertised recipes.
function recipeShopSellList(crafter, customer) {
    const entries = (crafter.model || crafter).manufactureShop?.entries || [];
    const packet = new SendPacket(0xd9);
    packet
        .writeD(crafter.fetchId())
        .writeD(crafter.fetchMp())
        .writeD(crafter.fetchMaxMp())
        .writeD(customer.backpack.fetchTotalAdena())
        .writeD(entries.length);
    entries.forEach((entry) => packet.writeD(entry.recipeId).writeD(0).writeD(entry.price));
    return packet.fetchBuffer();
}

module.exports = recipeShopSellList;
