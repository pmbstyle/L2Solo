const SendPacket = invoke('Packet/Send');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');

function abnormalStatusUpdate(buffs = []) {
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
    const effects = EffectStore.packetEffects(actor);
    if (effects.length > 0) {
        return abnormalStatusUpdate(effects);
    }

    const buffs = [];
    if (actor && actor.activeBuffs) {
        const now = Date.now();
        Object.values(BuffCatalog.ALL_BUFFS).forEach((buff) => {
            const expiresAt = actor.activeBuffs[buff.key];
            if (expiresAt && now < expiresAt) {
                buffs.push({
                    id: buff.id,
                    level: buff.level,
                    duration: Math.round((expiresAt - now) / 1000)
                });
            }
        });
    }
    return abnormalStatusUpdate(buffs);
};

module.exports = abnormalStatusUpdate;
