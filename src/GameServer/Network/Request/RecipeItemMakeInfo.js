const ReceivePacket = invoke('Packet/Receive');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const ServerResponse = invoke('GameServer/Network/Response');

function recipeItemMakeInfo(session, buffer) {
    if (!buffer || buffer.length !== 5) return;
    const packet = new ReceivePacket(buffer);
    packet.readD();
    const recipe = C4RecipeItems.resolveByRecipeId(packet.data[0]);
    const actor = session?.actor;
    if (!recipe || !actor?.backpack?.hasRecipe?.(actor, recipe.recipeId)) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return;
    }
    session.dataSendToMe(ServerResponse.recipeItemMakeInfo(
        recipe.recipeId,
        actor,
        recipe.type === 'dwarven',
        -1
    ));
}

module.exports = recipeItemMakeInfo;
