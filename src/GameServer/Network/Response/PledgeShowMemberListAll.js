const SendPacket = invoke('Packet/Send');
const Helpers = invoke('GameServer/Network/Response/PledgeHelpers');

function pledgeShowMemberListAll(clan, activeActor) {
    const packet = new SendPacket(0x53);
    const activeId = Number(activeActor?.fetchId?.() || 0);
    const members = clan.members || [];
    const visibleMembers = members.filter((member) => Number(member.id) !== activeId);
    const leader = members.find((member) => Number(member.id) === Number(clan.leaderId));

    packet
        .writeD(clan.id)
        .writeS(clan.name || '')
        .writeS(leader?.name || activeActor?.fetchName?.() || '')
        .writeD(clan.crestId || 0)
        .writeD(clan.level || 0)
        .writeD(0) // Castle
        .writeD(0) // Hideout / Clan Hall
        .writeD(0)
        .writeD(Number(activeActor?.fetchLevel?.() || 0))
        .writeD(clan.dissolvingExpiryTime > Date.now() ? 3 : 0)
        .writeD(0)
        .writeD(clan.allyId || 0)
        .writeS(clan.allyName || '')
        .writeD(clan.allyCrestId || 0)
        .writeD(0) // Clan war state
        .writeD(visibleMembers.length);

    visibleMembers.forEach((member) => {
        packet
            .writeS(member.name)
            .writeD(member.level)
            .writeD(member.classId)
            .writeD(0)
            .writeD(1)
            .writeD(Helpers.memberOnlineObjectId(member));
    });

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `clan=${clan.id}:${clan.name}:members=${members.length}:visible=${visibleMembers.length}:active=${activeId}`;
    return buffer;
}

module.exports = pledgeShowMemberListAll;
