const ReceivePacket = invoke('Packet/Receive');
const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function requestSetPledgeCrest(session, buffer) {
    const actorName = session?.actor?.fetchName?.() || session?.accountId || 'unknown';
    if (!buffer || buffer.length < 5) {
        utils.infoWarn('ClanCrest', 'upload rejected actor=%s reason=truncated_header packetBytes=%d',
            actorName, buffer?.length || 0);
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: 'truncated_header' });
    }

    const packet = new ReceivePacket(buffer);

    packet.readD();
    const length = Number(packet.data[0]) || 0;
    if (length < 0 || length > ClanService.SMALL_CREST_MAX_BYTES) {
        utils.infoWarn('ClanCrest', 'upload rejected actor=%s reason=invalid_size bytes=%d packetBytes=%d',
            actorName, length, buffer.length);
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: 'invalid_size' });
    }
    if (buffer.length < 5 + length) {
        utils.infoWarn('ClanCrest', 'upload rejected actor=%s reason=truncated_data bytes=%d packetBytes=%d',
            actorName, length, buffer.length);
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: 'truncated_data' });
    }

    packet.readB(length);
    utils.infoSuccess('ClanCrest', 'upload actor=%s bytes=%d packetBytes=%d signature=%s',
        actorName, length, buffer.length, packet.data[1]?.toString('ascii', 0, 4) || '');

    return ClanService.setSmallCrest(session.actor, packet.data[1]).then((result) => {
        if (!result.ok) {
            utils.infoWarn('ClanCrest', 'upload rejected actor=%s reason=%s bytes=%d',
                actorName, result.code || 'not_allowed', length);
            session.dataSendToMe(ServerResponse.actionFailed());
            return result;
        }

        utils.infoSuccess('ClanCrest', 'upload stored actor=%s clan=%d crest=%d bytes=%d deleted=%s',
            actorName, result.clan.id, result.crestId || 0, length, result.deleted ? 'yes' : 'no');
        session.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(result.clan));
        ClanService.broadcastAppearance(result.clan);
        return result;
    }).catch((error) => {
        utils.infoWarn('ClanCrest', 'upload failed actor=%s bytes=%d: %s', actorName, length, error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
        return { ok: false, code: 'upload_failed' };
    });
}

module.exports = requestSetPledgeCrest;
