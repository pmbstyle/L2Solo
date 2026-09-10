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

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `actor=${actor.fetchId()}:skill=${skill.fetchSelfId()}:level=${skill.fetchLevel?.() ?? 1}:targets=${visibleTargets.map(target => target?.fetchId?.() ?? 0).join(',')}`;
    return buffer;
}

module.exports = magicSkillLaunched;
