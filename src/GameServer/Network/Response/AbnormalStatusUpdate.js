const SendPacket = invoke('Packet/Send');
const EffectStore = invoke('GameServer/Effects/EffectStore');

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
        if (actor.activeBuffs.windWalk && now < actor.activeBuffs.windWalk) {
            buffs.push({
                id: 1204, // Wind Walk
                level: 2,
                duration: Math.round((actor.activeBuffs.windWalk - now) / 1000)
            });
        }
        if (actor.activeBuffs.shield && now < actor.activeBuffs.shield) {
            buffs.push({
                id: 1040, // Shield
                level: 2,
                duration: Math.round((actor.activeBuffs.shield - now) / 1000)
            });
        }
        if (actor.activeBuffs.haste && now < actor.activeBuffs.haste) {
            buffs.push({
                id: 1086, // Haste
                level: 2,
                duration: Math.round((actor.activeBuffs.haste - now) / 1000)
            });
        }
        if (actor.activeBuffs.might && now < actor.activeBuffs.might) {
            buffs.push({
                id: 1068, // Might
                level: 2,
                duration: Math.round((actor.activeBuffs.might - now) / 1000)
            });
        }
    }
    return abnormalStatusUpdate(buffs);
};

module.exports = abnormalStatusUpdate;
