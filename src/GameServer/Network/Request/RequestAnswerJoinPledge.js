const ReceivePacket = invoke('Packet/Receive');
const ClanInviteService = invoke('GameServer/Clan/ClanInviteService');

function requestAnswerJoinPledge(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD(); // Answer

    consume(session, {
        answer: packet.data[0]
    });
}

function consume(session, data) {
    return ClanInviteService.accept(session, { answer: data.answer });
}

module.exports = requestAnswerJoinPledge;
module.exports.consume = consume;
