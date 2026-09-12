const SendPacket = invoke('Packet/Send');

function magicSkillCanceld(objectId) {
    const buffer = (new SendPacket(0x49))
        .writeD(objectId)
        .fetchBuffer();
    buffer.__packetTrace = `actor=${objectId}`;
    return buffer;
}

module.exports = magicSkillCanceld;
