const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function requestWithdrawalPledge(session) {
    const actor = session.actor;
    const clan = ClanService.clanForActor(actor);

    if (!clan || ClanService.isLeader(actor, clan)) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const name = actor.fetchName();
    ClanService.removeMember(actor).then((result) => {
        session.dataSendToMe(ServerResponse.userInfo(actor));
        session.dataSendToMe(ServerResponse.pledgeShowMemberListDelete(name));
        ClanService.onlineSessions(result.clan).forEach((memberSession) => {
            memberSession.dataSendToMe(ServerResponse.pledgeShowMemberListDelete(name));
            memberSession.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(result.clan));
        });
    }).catch((err) => {
        utils.infoWarn('Clan', 'leave clan failed: %s', err.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    });
}

module.exports = requestWithdrawalPledge;
