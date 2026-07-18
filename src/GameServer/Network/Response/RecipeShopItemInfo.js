const SendPacket = invoke('Packet/Send');

function recipeShopItemInfo(crafter, recipeId, status) {
    const packet = new SendPacket(0xda);
    packet
        .writeD(crafter.fetchId())
        .writeD(recipeId)
        .writeD(crafter.fetchMp())
        .writeD(crafter.fetchMaxMp())
        .writeD(status);
    return packet.fetchBuffer();
}

module.exports = recipeShopItemInfo;
