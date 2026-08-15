const SendPacket = invoke('Packet/Send');

// C4 EnchantResult (0x81): 0 success, 1 item destroyed, 2 failed.
module.exports = function enchantResult(result) {
    return new SendPacket(0x81)
        .writeD(Number(result) || 0)
        .fetchBuffer();
};
