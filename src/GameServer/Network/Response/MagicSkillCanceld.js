const SendPacket = invoke('Packet/Send');

function magicSkillCanceld(objectId) {
    return (new SendPacket(0x49))
        .writeD(objectId)
        .fetchBuffer();
}

module.exports = magicSkillCanceld;
