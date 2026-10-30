const SendPacket = invoke('Packet/Send');

const RELATION_CLAN_MEMBER = 0x00040;
const RELATION_LEADER = 0x00080;
const RELATION_MUTUAL_WAR = 0x08000;
const RELATION_1SIDED_WAR = 0x10000;

function relationFor(actor, viewer = null) {
    const clanId = Number(actor?.fetchClanId?.() || 0);
    if (clanId === 0) return 0x00;

    const ClanService = invoke('GameServer/Clan/ClanService');
    const clan = ClanService.findById(clanId) || actor?.fetchClan?.();
    let relation = RELATION_CLAN_MEMBER;

    if (ClanService.isLeader(actor, clan)) {
        relation |= RELATION_LEADER;
    }

    if (viewer) {
        const war = invoke('GameServer/Clan/ClanWarRuntime').between(viewer, actor);
        // C4 keeps the viewer's declaration bit set for mutual war as well.
        if (war.outgoing) relation |= RELATION_1SIDED_WAR;
        if (war.mutual) relation |= RELATION_MUTUAL_WAR;
    }

    return relation;
}

function relationChanged(actor, viewer = null) {
    const packet = new SendPacket(0xce);
    const relation = relationFor(actor, viewer);

    packet
        .writeD(actor.fetchId())
        .writeD(relation)
        .writeD((actor.fetchKarma() > 0 || actor.fetchPvpFlag() > 0) ? 1 : 0) // C4 still uses force attack for white war targets
        .writeD(actor.fetchKarma())
        .writeD(actor.fetchPvpFlag());

    const buffer = packet.fetchBuffer();
    buffer.__relationActor = actor;
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true && process.env.L2NODE_PACKET_TRACE !== '0') buffer.__packetTrace = `actor=${actor.fetchId()}:${actor.fetchName()}:relation=${relation}`;
    return buffer;
}

relationChanged.RELATION_CLAN_MEMBER = RELATION_CLAN_MEMBER;
relationChanged.RELATION_LEADER = RELATION_LEADER;
relationChanged.RELATION_MUTUAL_WAR = RELATION_MUTUAL_WAR;
relationChanged.RELATION_1SIDED_WAR = RELATION_1SIDED_WAR;
relationChanged.relationFor = relationFor;

module.exports = relationChanged;
