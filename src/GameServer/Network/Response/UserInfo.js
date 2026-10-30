const SendPacket = invoke('Packet/Send');
const Pledge = invoke('GameServer/Network/Response/PledgeHelpers');
const ClanService = invoke('GameServer/Clan/ClanService');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const weaponEnchantEffect = invoke('GameServer/Network/Response/WeaponEnchantEffect');
const movementInfo = require('./CharacterMovementInfo');

function boatObjectId(actor) {
    const boat = actor?.fetchBoat?.() || actor?.boat;
    return Number(actor?.fetchBoatId?.() ?? boat?.fetchId?.() ?? boat?.id ?? 0) || 0;
}

function userInfo(actor) {
    const packet = new SendPacket(0x04);
    const clan = Pledge.clan(actor);
    const relation = ClanService.isLeader(actor, clan) ? 0x40 : 0x00;
    const movement = movementInfo(actor);
    const paperdollId = (slot) => actor.backpack.fetchPaperdollId(slot) || 0;
    const paperdollSelfId = (slot) => actor.backpack.fetchPaperdollSelfId(slot) || 0;
    // Two-hand gear lives in slot 14 locally, but C4 needs it in both weapon fields.
    const weaponId = paperdollId(7) || paperdollId(14);
    const weaponSelfId = paperdollSelfId(7) || paperdollSelfId(14);

    packet
        .writeD(actor.fetchLocX())
        .writeD(actor.fetchLocY())
        .writeD(actor.fetchLocZ())
        .writeD(boatObjectId(actor))
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

        for (let i = 0; i < 14; i++) {
            packet.writeD(i === 7 ? weaponId : paperdollId(i));
        }
        packet.writeD(weaponId) // C4 repeats the right-hand weapon here
            .writeD(0x00); // Hair equipment is not modelled locally

        for (let i = 0; i < 14; i++) {
            packet.writeD(i === 7 ? weaponSelfId : paperdollSelfId(i));
        }
        packet.writeD(weaponSelfId) // C4 repeats the right-hand weapon here
            .writeD(0x00); // Hair equipment is not modelled locally

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
        .writeD(movement.run)
        .writeD(movement.walk)
        .writeD(movement.swimRun)
        .writeD(movement.swimWalk)
        .writeD(movement.run)   // Floating Run Speed
        .writeD(movement.walk)  // Floating Walk Speed
        .writeD(movement.run)   // Flying Run Speed
        .writeD(movement.walk)  // Flying Walk Speed
        .writeF(movement.multiplier)
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
        .writeD(EffectStore.abnormalMask(actor))  // Abnormal effect
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
        .writeD(1000000 + (actor.fetchMountNpcId?.() || actor.mountNpcId || 0))  // Mount ID
        .writeH(0x00)  // Inventory limit
        .writeD(actor.fetchClassId())
        .writeD(0x00)  // Special effects
        .writeD(actor.fetchMaxCp())
        .writeD(actor.fetchCp())
        .writeC(actor.fetchMounted?.() || actor.mounted ? 0 : weaponEnchantEffect(actor))  // Enchant effect
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
