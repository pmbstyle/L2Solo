const SendPacket = invoke('Packet/Send');
const Pledge = invoke('GameServer/Network/Response/PledgeHelpers');

function charInfo(actor) {
    const packet = new SendPacket(0x03);
    const weaponDisplayId = actor.backpack.fetchPaperdollSelfId(7) || actor.backpack.fetchPaperdollSelfId(14) || 0;
    const pvpFlag = actor.fetchPvpFlag();
    const karma = actor.fetchKarma();
    const runSpeed = actor.fetchCollectiveRunSpd();
    const walkSpeed = actor.fetchCollectiveWalkSpd();
    const swimSpeed = actor.fetchSwim && actor.fetchSwim();
    const swimRunSpeed = swimSpeed || runSpeed;
    const swimWalkSpeed = swimSpeed || walkSpeed;
    const privateStoreType = actor.fetchPrivateStoreType();
    const standingState = actor.state.fetchSeated() ? 0x00 : 0x01;
    const title = actor.fetchTitle();

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
        .writeD(0x00)  // Hair all
        .writeD(actor.backpack.fetchPaperdollSelfId( 6)) // Head
        .writeD(weaponDisplayId) // Weapon
        .writeD(actor.backpack.fetchPaperdollSelfId( 8)) // Shield
        .writeD(actor.backpack.fetchPaperdollSelfId( 9)) // Hands
        .writeD(actor.backpack.fetchPaperdollSelfId(10)) // Chest
        .writeD(actor.backpack.fetchPaperdollSelfId(11)) // Pants
        .writeD(actor.backpack.fetchPaperdollSelfId(12)) // Feet
        .writeD(0x00)  // Back
        .writeD(weaponDisplayId) // Two-hand weapon display
        .writeD(0x00)  // Hair
        .writeD(pvpFlag)  // Purple = 0x01
        .writeD(karma)
        .writeD(actor.fetchCollectiveCastSpd())
        .writeD(actor.fetchCollectiveAtkSpd())
        .writeD(pvpFlag)  // Purple = 0x01
        .writeD(karma)
        .writeD(runSpeed)
        .writeD(walkSpeed)
        .writeD(swimRunSpeed)
        .writeD(swimWalkSpeed)
        .writeD(runSpeed)   // Floating run speed
        .writeD(walkSpeed)  // Floating walk speed
        .writeD(runSpeed)   // Flying run speed
        .writeD(walkSpeed)  // Flying walk speed
        .writeF(1.0)   // Move multiplier
        .writeF(actor.fetchAtkSpdMultiplier())
        .writeF(actor.fetchRadius())
        .writeF(actor.fetchSize())
        .writeD(actor.fetchHair())
        .writeD(actor.fetchHairColor())
        .writeD(actor.fetchFace())
        .writeS(title)
        .writeD(Pledge.clanId(actor))  // Clan Id
        .writeD(Pledge.crestId(actor))  // Clan Crest Id
        .writeD(Pledge.allyId(actor))  // Ally Id
        .writeD(Pledge.allyCrestId(actor))  // Ally Crest Id
        .writeD(0x00)  // ?
        .writeC(standingState)  // Sitting = 0, Standing = 1
        .writeC(0x01)  // Running = 1
        .writeC(0x00)  // Combat = 1
        .writeC(0x00)  // Dead = 1
        .writeC(0x00)  // Invisible = 1
        .writeC(0x00)  // Mount
        .writeC(privateStoreType)  // Private store type
        .writeH(0x00)  // Cubic count
        .writeC(0x00)  // Party matching
        .writeD(0x00)  // Abnormal effect
        .writeC(0x00)  // Recommendations left
        .writeH(0x00)  // Recommendations won
        .writeD(0x00)  // Mount NPC ID
        .writeD(actor.fetchClassId())
        .writeD(0x00)  // Special effects
        .writeC(0x00)  // Enchant effect
        .writeC(0x00)  // Team circle color
        .writeD(Pledge.largeCrestId(actor))  // Clan large crest ID
        .writeC(0x00)  // Noble
        .writeC(0x00)  // Hero
        .writeC(0x00)  // Fishing
        .writeD(0x00)  // Fishing X
        .writeD(0x00)  // Fishing Y
        .writeD(0x00)  // Fishing Z
        .writeD(0xffffff); // Name color

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `char=${actor.fetchId()}:${actor.fetchName()}:store=${actor.fetchPrivateStoreType()}:stand=${standingState}:titleLen=${title.length}`;
    return buffer;
}

module.exports = charInfo;
