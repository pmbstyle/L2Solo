const SendPacket = invoke('Packet/Send');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function partySpelled(objectId, effects = [], summon = 0) {
    const packet = new SendPacket(0xee);

    packet
        .writeD(summon)
        .writeD(objectId)
        .writeD(effects.length);

    effects.forEach((effect) => {
        packet
            .writeD(effect.id)
            .writeH(effect.level)
            .writeD(effect.duration);
    });

    return packet.fetchBuffer();
}

partySpelled.fromActor = function(actor, summon = 0) {
    return partySpelled(actor.fetchId(), EffectStore.packetEffects(actor), summon);
};

module.exports = partySpelled;
