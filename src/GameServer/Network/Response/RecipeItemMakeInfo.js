const SendPacket = invoke('Packet/Send');

// C4 RecipeItemMakeInfo (0xD7), status: 1 success, 0 failed/aborted.
function recipeItemMakeInfo(recipeId, actor, dwarven, status) {
    const packet = new SendPacket(0xd7);
    packet
        .writeD(Number(recipeId) || 0)
        .writeD(dwarven ? 0 : 1)
        .writeD(Math.max(0, Number(actor?.fetchMp?.()) || 0))
        .writeD(Math.max(0, Number(actor?.fetchMaxMp?.()) || 0))
        .writeD(Number(status) || 0);
    return packet.fetchBuffer();
}

module.exports = recipeItemMakeInfo;
