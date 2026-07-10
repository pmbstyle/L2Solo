const SendPacket = invoke('Packet/Send');
const Pledge = invoke('GameServer/Network/Response/PledgeHelpers');
const ClanService = invoke('GameServer/Clan/ClanService');

function userInfo(actor) {
    const packet = new SendPacket(0x04);
    const clan = Pledge.clan(actor);
    const relation = ClanService.isLeader(actor, clan) ? 0x40 : 0x00;

    packet
        .writeD(actor.fetchLocX())
        .writeD(actor.fetchLocY())
        .writeD(actor.fetchLocZ())
        .writeD(actor.fetchHead())
        .writeD(actor.fetchId())
        .writeS(actor.fetchName())
        .writeD(actor.fetchRace())
        .writeD(actor.fetchSex())
        .writeD(actor.fetchClassId())
        .writeD(actor.fetchLevel())
        .writeD(actor.fetchExp())
        .writeD(actor.fetchStr())
        .writeD(actor.fetchDex())
        .writeD(actor.fetchCon())
        .writeD(actor.fetchInt())
        .writeD(actor.fetchWit())
        .writeD(actor.fetchMen())
        .writeD(actor.fetchMaxHp())
        .writeD(actor.fetchHp())
        .writeD(actor.fetchMaxMp())
        .writeD(actor.fetchMp())
        .writeD(actor.fetchSp())
        .writeD(actor.backpack.fetchTotalLoad())
        .writeD(actor.fetchMaxLoad())
        .writeD(0x28); // ?

        for (let i = 0; i < 16; i++) {
            packet
                .writeD(actor.backpack.fetchPaperdollId(i));
        }

        for (let i = 0; i < 16; i++) {
            packet
                .writeD(actor.backpack.fetchPaperdollSelfId(i));
        }

    packet
        .writeD(actor.fetchCollectivePAtk())
        .writeD(actor.fetchCollectiveAtkSpd())
        .writeD(actor.fetchCollectivePDef())
        .writeD(actor.fetchCollectiveEvasion())
        .writeD(actor.fetchCollectiveAccur())
        .writeD(actor.fetchCollectiveCritical())
        .writeD(actor.fetchCollectiveMAtk())
        .writeD(actor.fetchCollectiveCastSpd())
        .writeD(actor.fetchCollectiveAtkSpd())
        .writeD(actor.fetchCollectiveMDef())
        .writeD(actor.fetchPvpFlag())  // Purple = 0x01
        .writeD(actor.fetchKarma())
        .writeD(actor.fetchCollectiveRunSpd())
        .writeD(actor.fetchCollectiveWalkSpd())
        .writeD(actor.fetchSwim())
        .writeD(actor.fetchSwim())
        .writeD(0x00)  // Floating Run Speed
        .writeD(0x00)  // Floating Walk Speed
        .writeD(0x00)  // Flying Run Speed
        .writeD(0x00)  // Flying Walk Speed
        .writeF(1.0)   // Movement Multiplier
        .writeF(actor.fetchAtkSpdMultiplier())
        .writeF(actor.fetchRadius())
        .writeF(actor.fetchSize())
        .writeD(actor.fetchHair())
        .writeD(actor.fetchHairColor())
        .writeD(actor.fetchFace())
        .writeD(actor.fetchIsGM())
        .writeS(actor.fetchTitle())
        .writeD(Pledge.clanId(actor))  // Clan ID
        .writeD(Pledge.crestId(actor))  // Clan Crest ID
        .writeD(Pledge.allyId(actor))  // Ally ID
        .writeD(Pledge.allyCrestId(actor))  // Ally Crest ID
        .writeD(relation)  // Clan leader / siege relation flags
        .writeC(0x00)  // ?
        .writeC(actor.fetchPrivateStoreType())  // Private Store Type
        .writeC(actor.fetchIsCrafter())
        .writeD(actor.fetchPk())
        .writeD(actor.fetchPvp())
        .writeH((actor.cubics instanceof Map ? actor.cubics.size : 0));  // Cubic Count

    for (const cubicId of actor.cubics instanceof Map ? actor.cubics.keys() : []) {
        packet.writeH(cubicId);
    }

    packet
        .writeC(0x00)  // Find Party Members = 0x01
        .writeD(0x00)  // Is invisible?
        .writeC(0x00)  // ?
        .writeD(Pledge.privileges(actor))  // Clan Privileges
        .writeD(0x00)  // ?
        .writeD(0x00)  // ?
        .writeD(0x00)  // ?
        .writeD(0x00)  // ?
        .writeD(0x00)  // ?
        .writeD(0x00)  // ?
        .writeD(0x00)  // ?
        .writeH(actor.fetchRecRemain())
        .writeH(actor.fetchEvalScore())
        .writeD(0x00)  // Mount ID
        .writeH(0x00)  // Inventory limit
        .writeD(actor.fetchClassId())
        .writeD(0x00)  // Special effects
        .writeD(actor.fetchMaxCp())
        .writeD(actor.fetchCp())
        .writeC(0x00)  // Mounted
        .writeC(0x00)  // Team circle color
        .writeD(Pledge.largeCrestId(actor))  // Clan large crest ID
        .writeC(0x00)  // Noble
        .writeC(0x00)  // Hero
        .writeC(0x00)  // Fishing
        .writeD(0x00)  // Fishing X
        .writeD(0x00)  // Fishing Y
        .writeD(0x00)  // Fishing Z
        .writeD(0xffffff); // Name color

    return packet.fetchBuffer();
}

module.exports = userInfo;
