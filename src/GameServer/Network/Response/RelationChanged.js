const SendPacket = invoke('Packet/Send');

const RELATION_CLAN_MEMBER = 0x00040;
const RELATION_LEADER = 0x00080;

function relationFor(actor) {
    const clanId = Number(actor?.fetchClanId?.() || 0);
    if (clanId === 0) return 0x00;

    const ClanService = invoke('GameServer/Clan/ClanService');
    const clan = ClanService.findById(clanId) || actor?.fetchClan?.();
    let relation = RELATION_CLAN_MEMBER;

    if (ClanService.isLeader(actor, clan)) {
        relation |= RELATION_LEADER;
    }

    return relation;
}

function relationChanged(actor) {
    const packet = new SendPacket(0xce);
    const relation = relationFor(actor);

    packet
        .writeD(actor.fetchId())
        .writeD(relation)
        .writeD((actor.fetchKarma() > 0 || actor.fetchPvpFlag() > 0) ? 1 : 0) // autoattackable
        .writeD(actor.fetchKarma())
        .writeD(actor.fetchPvpFlag());

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `actor=${actor.fetchId()}:${actor.fetchName()}:relation=${relation}`;
    return buffer;
}

relationChanged.RELATION_CLAN_MEMBER = RELATION_CLAN_MEMBER;
relationChanged.RELATION_LEADER = RELATION_LEADER;
relationChanged.relationFor = relationFor;

module.exports = relationChanged;
