const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

function isBotSession(session) {
    return !!(session && (
        session.constructor.name === 'BotSession' ||
        String(session.accountId || '').startsWith('bot_')
    ));
}

function broadcastClan(clan, packetFactory) {
    ClanService.onlineSessions(clan).forEach((memberSession) => {
        memberSession.dataSendToMe(packetFactory(memberSession));
    });
}

function refreshAppearance(session) {
    if (!session?.actor) return;
    if (!session.actor.backpack || !session.actor.fetchHead) return;

    session.dataSendToMe(ServerResponse.userInfo(session.actor));
    session.dataSendToOthers(ServerResponse.charInfo(session.actor), session.actor);
    session.dataSendToOthers(ServerResponse.relationChanged(session.actor), session.actor);
}

function accept(session, options = {}) {
    const answer = options.answer === undefined ? 1 : Number(options.answer);
    const invite = session.pendingClanInvite;
    session.pendingClanInvite = null;

    if (!invite?.requestorSession?.actor) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: 'missing_invite' });
    }

    const requestor = invite.requestorSession.actor;
    const clan = ClanService.findById(invite.clanId);
    if (!answer || !clan) {
        invite.requestorSession.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: answer ? 'missing_clan' : 'declined' });
    }

    const allowed = ClanService.canInvite(requestor, session.actor);
    if (!allowed.ok || Number(allowed.clan.id) !== Number(clan.id)) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: allowed.code || 'not_allowed' });
    }

    return ClanService.addMember(clan, session.actor, 0).then((result) => {
        session.dataSendToMe(ServerResponse.joinPledge(clan.id));
        session.dataSendToMe(ServerResponse.pledgeShowMemberListAll(
            ClanService.refreshOnlineMembers(clan),
            session.actor
        ));
        session.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(clan));
        refreshAppearance(session);

        broadcastClan(clan, (memberSession) => (
            memberSession === session
                ? ServerResponse.pledgeShowInfoUpdate(clan)
                : ServerResponse.pledgeShowMemberListAdd(result.member)
        ));

        if (options.automated && isBotSession(session)) {
            const BotManager = invoke('GameServer/Bot/BotManager');
            BotManager.botTell(session, invite.requestorSession, `I'll join ${clan.name}.`);
        }

        return { ok: true, clan, member: result.member };
    }).catch((err) => {
        utils.infoWarn('Clan', 'join clan failed: %s', err.message);
        session.dataSendToMe(ServerResponse.actionFailed());
        return { ok: false, code: 'join_failed' };
    });
}

module.exports = {
    accept,
    isBotSession
};
