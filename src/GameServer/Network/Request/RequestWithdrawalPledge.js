const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');
const ActionMessage = invoke('GameServer/Clan/ClanActionMessage');

function requestWithdrawalPledge(session) {
    const actor = session.actor;
    const clan = ClanService.clanForActor(actor);

    if (!clan || ClanService.isLeader(actor, clan)) {
        session.dataSendToMe(ServerResponse.actionFailed());
        ActionMessage.failure(session, clan ? 'leader_cannot_leave' : 'no_clan');
        return Promise.resolve({ ok: false, code: 'leader_cannot_leave' });
    }

    const name = actor.fetchName();
    return ClanService.removeMember(actor).then((result) => {
        if (!result.ok) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return result;
        }
        session.dataSendToMe(ServerResponse.userInfo(actor));
        session.dataSendToMe(ServerResponse.pledgeShowMemberListDelete(name));
        session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
        session.dataSendToOthers?.(ServerResponse.relationChanged(actor), actor);
        ClanService.onlineSessions(result.clan).forEach((memberSession) => {
            memberSession.dataSendToMe(ServerResponse.pledgeShowMemberListDelete(name));
            memberSession.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(result.clan));
        });
        ActionMessage.send(session, `You left clan ${result.clan.name}.`);
        return result;
    }).catch((err) => {
        utils.infoWarn('Clan', 'leave clan failed: %s', err.message);
        session.dataSendToMe(ServerResponse.actionFailed());
        ActionMessage.failure(session, 'leave_failed');
        return { ok: false, code: 'leave_failed' };
    });
}

module.exports = requestWithdrawalPledge;
