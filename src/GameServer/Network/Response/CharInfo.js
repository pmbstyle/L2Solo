const SendPacket = invoke('Packet/Send');
const Pledge = invoke('GameServer/Network/Response/PledgeHelpers');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const weaponEnchantEffect = invoke('GameServer/Network/Response/WeaponEnchantEffect');

function boatObjectId(actor) {
    const boat = actor?.fetchBoat?.() || actor?.boat;
    return Number(actor?.fetchBoatId?.() ?? boat?.fetchId?.() ?? boat?.id ?? 0) || 0;
}

function movementInfo(actor) {
    const collectiveRun = Math.max(0, Number(actor.fetchCollectiveRunSpd?.()) || 0);
    const collectiveWalk = Math.max(0, Number(actor.fetchCollectiveWalkSpd?.()) || 0);
    const running = actor.state?.fetchWalkin?.() !== true;
    const baseRun = Math.max(0, Number(actor.fetchRunSpd?.()) || collectiveRun);
    const baseWalk = Math.max(0, Number(actor.fetchWalkSpd?.()) || collectiveWalk);
    const activeCollective = running ? collectiveRun : collectiveWalk;
    const activeBase = running ? baseRun : baseWalk;
    const multiplier = activeBase > 0 && activeCollective > 0
        ? activeCollective / activeBase
        : 1;
    const safeMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

    // C4 keeps template speeds and the current stat multiplier in separate
    // fields.  Sending the already-modified speed with a hard-coded 1.0 makes
    // remote-character interpolation and animation disagree with the server.
    return {
        run: Math.round(baseRun),
        walk: Math.round(baseWalk),
        multiplier: safeMultiplier
    };
}

function charInfo(actor) {
    const packet = new SendPacket(0x03);
    const weaponDisplayId = actor.backpack.fetchPaperdollSelfId(7) || actor.backpack.fetchPaperdollSelfId(14) || 0;
    const pvpFlag = actor.fetchPvpFlag();
    const karma = actor.fetchKarma();
    const movement = movementInfo(actor);
    const runSpeed = movement.run;
    const walkSpeed = movement.walk;
    const swimSpeed = actor.fetchSwim && actor.fetchSwim();
    const swimRunSpeed = swimSpeed ? Math.round(swimSpeed / movement.multiplier) : runSpeed;
    const swimWalkSpeed = swimSpeed ? Math.round(swimSpeed / movement.multiplier) : walkSpeed;
    const privateStoreType = actor.fetchPrivateStoreType();
    const standingState = actor.state.fetchSeated() ? 0x00 : 0x01;
    const runningState = actor.state.fetchWalkin?.() ? 0x00 : 0x01;
    // The C4 client renders this flag as a persistent red combat aura around
    // the nameplate. Combat is already represented by AutoAttackStart/Stop,
    // so do not expose this cosmetic state in CharInfo for players or bots.
    const combatState = 0x00;
    const deadState = actor.state.fetchDead?.() ? 0x01 : 0x00;
    const title = actor.fetchTitle();

    packet
        .writeD(actor.fetchLocX())
        .writeD(actor.fetchLocY())
        .writeD(actor.fetchLocZ())
        // C4 reserves this field for the boat object id, not the character
        // heading. A non-zero heading made every ordinary character appear
        // attached to a non-existent vehicle on the client.
        .writeD(boatObjectId(actor))
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
        .writeF(movement.multiplier)
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
        .writeC(runningState)  // Running = 1
        .writeC(combatState)  // Combat = 1
        .writeC(deadState)  // Dead = 1
        .writeC(0x00)  // Invisible = 1
        .writeC(actor.fetchMounted?.() || actor.mounted ? 1 : 0)  // Mount
        .writeC(privateStoreType)  // Private store type
        .writeH((actor.cubics instanceof Map ? actor.cubics.size : 0));  // Cubic count

    for (const cubicId of actor.cubics instanceof Map ? actor.cubics.keys() : []) {
        packet.writeH(cubicId);
    }

    packet
        .writeC(0x00)  // Party matching
        .writeD(EffectStore.abnormalMask(actor))  // Abnormal effect
        .writeC(0x00)  // Recommendations left
        .writeH(0x00)  // Recommendations won
        .writeD(actor.fetchMountNpcId?.() || 0)  // Mount NPC ID
        .writeD(actor.fetchClassId())
        .writeD(0x00)  // Special effects
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

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `char=${actor.fetchId()}:${actor.fetchName()}:store=${actor.fetchPrivateStoreType()}:stand=${standingState}:run=${runningState}:baseRun=${runSpeed}:baseWalk=${walkSpeed}:moveMult=${movement.multiplier}:collectiveRun=${actor.fetchCollectiveRunSpd?.()}:combat=${combatState}:dead=${deadState}:titleLen=${title.length}`;
    return buffer;
}

module.exports = charInfo;
module.exports.movementInfo = movementInfo;
