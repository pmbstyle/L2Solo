const SendPacket = invoke('Packet/Send');

function charSelectInfo(characters) {
    const packet = new SendPacket(0x13);

    packet
        .writeD(utils.size(characters));

    characters.forEach((character) => {
        const paperdollId = (slot) => character.paperdoll[slot]?.id || 0;
        const paperdollSelfId = (slot) => character.paperdoll[slot]?.selfId || 0;
        const weaponId = paperdollId(7) || paperdollId(14);
        const weaponSelfId = paperdollSelfId(7) || paperdollSelfId(14);

        packet
            .writeS(character.name)
            .writeD(character.id)
            .writeS(character.username)
            .writeD(0x55555555)
            .writeD(0x00)  // ?
            .writeD(0x00)  // ?
            .writeD(character.sex)
            .writeD(character.race)
            .writeD(character.classId)
            .writeD(0x01)  // ?
            .writeD(character.locX)
            .writeD(character.locY)
            .writeD(character.locZ)
            .writeF(character.hp)
            .writeF(character.mp)
            .writeD(character.sp)
            .writeD(character.exp)
            .writeD(character.level)
            .writeD(character.karma)
            .writeD(0x00)  // ?
            .writeD(0x00)  // ?
            .writeD(0x00)  // ?
            .writeD(0x00)  // ?
            .writeD(0x00)  // ?
            .writeD(0x00)  // ?
            .writeD(0x00)  // ?
            .writeD(0x00)  // ?
            .writeD(0x00); // ?

        for (let i = 0; i < 14; i++) {
            packet.writeD(paperdollId(i));
        }
        packet.writeD(weaponId)
            .writeD(0x00);

        for (let i = 0; i < 14; i++) {
            packet.writeD(paperdollSelfId(i));
        }
        packet.writeD(weaponSelfId)
            .writeD(0x00);

        packet
            .writeD(character.hair)
            .writeD(character.hairColor)
            .writeD(character.face)
            .writeF(character.maxHp)
            .writeF(character.maxMp)
            .writeD(0x00)  // Time before deletion
            .writeD(character.classId)
            .writeD(0x00)  // Active character slot
            .writeC(0x00); // Enchant effect
    });

    return packet.fetchBuffer();
}

module.exports = charSelectInfo;
