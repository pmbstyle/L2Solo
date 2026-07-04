const SendPacket = invoke('Packet/Send');

function magicSkillLaunched(actor, skill, targets = []) {
    const packet = new SendPacket(0x76);
    const visibleTargets = targets.length ? targets : [actor];

    packet
        .writeD(actor.fetchId())
        .writeD(skill.fetchSelfId())
        .writeD(skill.fetchLevel ? skill.fetchLevel() : 1)
        .writeD(visibleTargets.length);

    visibleTargets.forEach((target) => {
        packet.writeD(target?.fetchId ? target.fetchId() : 0);
    });

    return packet.fetchBuffer();
}

module.exports = magicSkillLaunched;
