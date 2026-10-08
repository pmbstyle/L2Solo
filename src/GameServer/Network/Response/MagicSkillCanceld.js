const SendPacket = invoke('Packet/Send');

function magicSkillCanceld(objectId) {
    const buffer = (new SendPacket(0x49))
        .writeD(objectId)
        .fetchBuffer();
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true && process.env.L2NODE_PACKET_TRACE !== '0') buffer.__packetTrace = `actor=${objectId}`;
    return buffer;
}

module.exports = magicSkillCanceld;
