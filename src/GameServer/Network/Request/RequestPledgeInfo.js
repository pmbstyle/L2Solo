const ReceivePacket = invoke('Packet/Receive');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function requestPledgeInfo(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet.readD();

    const clan = ClanService.findById(packet.data[0]);
    if (!clan) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    session.dataSendToMe(ServerResponse.pledgeInfo(clan));
}

module.exports = requestPledgeInfo;
