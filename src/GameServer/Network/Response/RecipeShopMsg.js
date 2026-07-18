const SendPacket = invoke('Packet/Send');
function recipeShopMsg(actor) { const packet = new SendPacket(0xdb); packet.writeD(actor.fetchId()).writeS((actor.model || actor).manufactureShop?.title || ''); return packet.fetchBuffer(); }
module.exports = recipeShopMsg;
