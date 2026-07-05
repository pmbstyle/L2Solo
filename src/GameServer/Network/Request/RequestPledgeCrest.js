const ReceivePacket = invoke('Packet/Receive');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function requestPledgeCrest(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet.readD();

    ClanService.findSmallCrest(packet.data[0]).then((crest) => {
        if (!crest) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        session.dataSendToMe(ServerResponse.pledgeCrest(crest.id, crest.data));
    });
}

module.exports = requestPledgeCrest;
