const ReceivePacket = invoke('Packet/Receive');
const RecipeCrafting = invoke('GameServer/Crafting/RecipeCrafting');

function recipeItemMakeSelf(session, buffer) {
    if (!buffer || buffer.length !== 5) return;
    const packet = new ReceivePacket(buffer);
    packet.readD();
    return RecipeCrafting.craftSelf(session, packet.data[0]);
}

module.exports = recipeItemMakeSelf;
