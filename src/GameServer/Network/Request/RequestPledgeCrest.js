const ReceivePacket = invoke('Packet/Receive');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function requestPledgeCrest(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet.readD();

    const crestId = Number(packet.data[0]) || 0;
    // The C4 client sends only crestId. Some later protocol variants append
    // clanId, so consume it only when it is present instead of rejecting the
    // native C4 request as a truncated packet.
    const clanId = buffer && buffer.length >= 9
        ? (packet.readD(), Number(packet.data[1]) || 0)
        : 0;
    const actorName = session?.actor?.fetchName?.() || session?.accountId || 'unknown';
    utils.infoSuccess('ClanCrest', 'request actor=%s crest=%d clan=%d packetBytes=%d',
        actorName, crestId, clanId, buffer?.length || 0);

    return ClanService.findSmallCrest(crestId).then((crest) => {
        if (!crest) {
            utils.infoWarn('ClanCrest', 'missing crest actor=%s crest=%d clan=%d', actorName, crestId, clanId);
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        const response = ServerResponse.pledgeCrest(crest.id, crest.data);
        utils.infoSuccess('ClanCrest', 'response actor=%s crest=%d clan=%d bytes=%d signature=%s',
            actorName, crest.id, crest.clanId, crest.data.length, crest.data.toString('ascii', 0, 2));
        session.dataSendToMe(response);
    }).catch((error) => {
        utils.infoWarn('ClanCrest', 'request failed actor=%s crest=%d clan=%d: %s',
            actorName, crestId, clanId, error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    });
}

module.exports = requestPledgeCrest;
