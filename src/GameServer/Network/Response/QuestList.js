const SendPacket = invoke('Packet/Send');

function questList(quests = []) {
    const packet = new SendPacket(0x80);

    packet.writeH(quests.length);
    quests.forEach((quest) => {
        packet.writeD(quest.id).writeD(quest.condition);
    });

    return packet.fetchBuffer();
}

module.exports = questList;
