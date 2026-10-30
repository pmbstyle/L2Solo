const ClanService = invoke('GameServer/Clan/ClanService');
const ServerResponse = invoke('GameServer/Network/Response');

// C4/Lisvus CheckClanJoinCondition: target penalties precede the capacity check.
const FAILURE_MESSAGES = {
    no_clan: 212,
    no_privilege: 794,
    clan_invite_cooldown: 231,
    target_has_clan: 10,
    clan_full: 233
};

function notifyRejection(session, code, target) {
    if (code === 'target_join_cooldown') {
        const minutes = Math.max(1, Math.ceil((target.fetchClanJoinExpiryTime() - Date.now()) / 60000));
        const remaining = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
        session.dataSendToMe(ServerResponse.systemMessage.text(
            `${target.fetchName()} cannot join another clan yet. Penalty remaining: ${remaining} (real time).`
        ));
        return;
    }
    const id = code === 'invalid_target' && target === session.actor ? 4 : FAILURE_MESSAGES[code];
    if (!id) return;
    const args = [231, 10].includes(id) ? [target.fetchName()] : [];
    session.dataSendToMe(ServerResponse.systemMessage(id, ...args));
}

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

    if (!invite?.requestorSession?.actor || invite.invitedActor !== session.actor) {
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
        notifyRejection(invite.requestorSession, allowed.code, session.actor);
        session.dataSendToMe(ServerResponse.actionFailed());
        return Promise.resolve({ ok: false, code: allowed.code || 'not_allowed' });
    }

    // The join is the invited character's even if the connection selects
    // another one meanwhile; only its UI is skipped then.
    const actor = session.actor;
    return ClanService.addMember(clan, actor, 0).then((result) => {
        if (!result.ok) return result;
        const current = session.actor === actor;
        if (current) {
            session.dataSendToMe(ServerResponse.joinPledge(clan.id));
            session.dataSendToMe(ServerResponse.pledgeShowMemberListAll(
                ClanService.refreshOnlineMembers(clan),
                actor
            ));
            session.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(clan));
            refreshAppearance(session);
        }

        broadcastClan(clan, (memberSession) => (
            memberSession === session
                ? ServerResponse.pledgeShowInfoUpdate(clan)
                : ServerResponse.pledgeShowMemberListAdd(result.member)
        ));

        if (current && options.automated && isBotSession(session)) {
            const BotManager = invoke('GameServer/Bot/BotManager');
            BotManager.botTell(session, invite.requestorSession, `I'll join ${clan.name}.`);
        }

        if (current && isBotSession(session)) invoke('GameServer/Bot/AI/BotClanChat').onJoined(session, clan.id);

        return { ok: true, clan, member: result.member };
    }).catch((err) => {
        utils.infoWarn('Clan', 'join clan failed: %s', err.message);
        if (session.actor === actor) session.dataSendToMe(ServerResponse.actionFailed());
        return { ok: false, code: 'join_failed' };
    });
}

module.exports = {
    accept,
    notifyRejection,
    isBotSession
};
