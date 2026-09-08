const SendPacket = invoke('Packet/Send');
const Limits = require('../../PrivateStoreLimits');

module.exports = function exStorageMaxCount(actor) {
    const dwarf = Number(actor?.fetchRace?.()) === 4;
    const bonus = (id, perLevel) => Math.max(0, Math.min(8, Limits.skillLevel(actor, id))) * perLevel;
    return new SendPacket(0xfe).writeH(0x2e)
        .writeD((dwarf ? 100 : 80) + bonus(1372, 6))
        .writeD((dwarf ? 120 : 100) + bonus(1371, 6))
        .writeD(20 + bonus(1371, 6))
        .writeD(Limits.forActor(actor, 1))
        .writeD(Limits.forActor(actor, 3))
        .writeD(50 + bonus(1368, 6))
        .writeD(50 + bonus(1369, 6))
        .fetchBuffer();
};
