const SendPacket = invoke('Packet/Send');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function abnormalStatusUpdate(buffs = []) {
    buffs = EffectStore.limitPacketEffects(buffs, EffectStore.SELF_PACKET_LIMIT);
    const packet = new SendPacket(0x7f); // Opcode 0x7f for MagicEffectIcons / AbnormalStatusUpdate

    packet.writeH(buffs.length); // List count

    buffs.forEach(buff => {
        packet.writeD(buff.id);       // Skill ID
        packet.writeH(buff.level);    // Skill level
        packet.writeD(buff.duration); // Duration in seconds remaining
    });

    return packet.fetchBuffer();
}

abnormalStatusUpdate.fromActor = function(actor) {
    return abnormalStatusUpdate(EffectStore.packetEffects(actor, { includeShortBuffs: false }));
};

module.exports = abnormalStatusUpdate;
