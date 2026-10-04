const ReceivePacket = invoke('Packet/Receive');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');
const ActionMessage = invoke('GameServer/Clan/ClanActionMessage');

function requestPledgeInfo(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet.readD();

    const clan = ClanService.findById(packet.data[0]);
    if (!clan) {
        session.dataSendToMe(ServerResponse.actionFailed());
        ActionMessage.failure(session, 'not_member');
        return;
    }

    session.dataSendToMe(ServerResponse.pledgeInfo(clan));
    ActionMessage.send(session, `Clan information opened for ${clan.name}.`);
}

module.exports = requestPledgeInfo;
