const SendPacket = invoke('Packet/Send');

function recipeShopManageList(actor) {
    const shop = (actor.model || actor).manufactureShop || { type: 'dwarven', entries: [] };
    const recipes = actor.backpack.fetchRecipeBook(actor, shop.type);
    const entries = shop.entries;
    const packet = new SendPacket(0xd8);
    packet.writeD(shop.type === 'dwarven' ? 0 : 1).writeD(actor.fetchMp()).writeD(actor.fetchMaxMp()).writeD(recipes.length);
    recipes.forEach((recipe, index) => packet.writeD(recipe.recipeId).writeD(index + 1));
    packet.writeD(entries.length);
    entries.forEach((entry) => packet.writeD(entry.recipeId).writeD(0).writeD(entry.price));
    return packet.fetchBuffer();
}
module.exports = recipeShopManageList;
