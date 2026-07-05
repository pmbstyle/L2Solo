const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function requestPledgeMemberList(session) {
    const clan = ClanService.clanForActor(session.actor);
    if (!clan) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const refreshed = ClanService.refreshOnlineMembers(clan);
    session.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(refreshed));
    session.dataSendToMe(ServerResponse.pledgeShowMemberListAll(
        refreshed,
        session.actor
    ));
}

module.exports = requestPledgeMemberList;
