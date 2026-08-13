const SendPacket = invoke('Packet/Send');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function shortBuffStatusUpdate(skillId = 0, level = 0, duration = 0) {
    const packet = new SendPacket(0xf4);
    packet
        .writeD(skillId)
        .writeD(level)
        .writeD(duration);
    return packet.fetchBuffer();
}

shortBuffStatusUpdate.fromActor = function(actor) {
    const effect = EffectStore.shortBuff(actor);
    if (!effect) return shortBuffStatusUpdate();
    return shortBuffStatusUpdate(
        effect.id,
        effect.level || 1,
        Math.max(0, Math.round(EffectStore.remainingMs(actor, effect.key) / 1000))
    );
};

module.exports = shortBuffStatusUpdate;
