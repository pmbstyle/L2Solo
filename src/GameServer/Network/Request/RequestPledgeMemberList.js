const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');
const ActionMessage = invoke('GameServer/Clan/ClanActionMessage');

function requestPledgeMemberList(session) {
    const clan = ClanService.clanForActor(session.actor);
    if (!clan) {
        session.dataSendToMe(ServerResponse.actionFailed());
        ActionMessage.failure(session, 'no_clan');
        return;
    }

    const refreshed = ClanService.refreshOnlineMembers(clan);
    session.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(refreshed));
    session.dataSendToMe(ServerResponse.pledgeShowMemberListAll(
        refreshed,
        session.actor
    ));
    ActionMessage.send(session, `Clan member list opened for ${refreshed.name}.`);
}

module.exports = requestPledgeMemberList;
