const SendPacket = invoke('Packet/Send');

// C4 RecipeBookItemList (0xD6): opens either the dwarven or common recipe book.
function recipeBookItemList(actor, dwarven) {
    const recipes = actor?.backpack?.fetchRecipeBook?.(actor, dwarven ? 'dwarven' : 'common') || [];
    const packet = new SendPacket(0xd6);

    packet
        .writeD(dwarven ? 0 : 1)
        .writeD(Math.max(0, Number(actor?.fetchMaxMp?.()) || 0))
        .writeD(recipes.length);

    recipes.forEach((recipe, index) => {
        packet
            .writeD(Number(recipe.recipeId) || 0)
            .writeD(index + 1);
    });

    return packet.fetchBuffer();
}

module.exports = recipeBookItemList;
