const ServerResponse = invoke('GameServer/Network/Response');

const ERROR_TEXT = {
    no_clan: 'You are not in a clan.',
    no_privilege: 'You do not have the required clan privilege.',
    invalid_target: 'The selected target is invalid.',
    clan_invite_cooldown: 'Your clan cannot invite members yet.',
    target_has_clan: 'The target is already in a clan.',
    target_join_cooldown: 'The target must wait before joining another clan.',
    clan_full: 'Your clan has reached its member limit.',
    missing_invite: 'No pending clan invitation was found.',
    declined: 'The clan invitation was declined.',
    not_allowed: 'The clan invitation is no longer valid.',
    join_failed: 'Failed to join the clan.',
    not_authorized: 'You are not authorized to perform this clan action.',
    not_leader: 'Only the clan leader may perform this action.',
    leader_cannot_leave: 'The clan leader cannot leave or be removed.',
    not_member: 'The character is not a member of this clan.',
    autonomous_membership_permanent: 'This clan membership cannot be removed.',
    target_offline: 'The target clan member is offline.',
    cannot_change_self: 'You cannot change your own clan privileges.',
    level_too_low: 'The clan level is too low for this action.',
    title_too_long: 'The clan title is too long.',
    no_clan_crest: 'The clan crest could not be found.',
    invalid_size: 'The clan crest size is invalid.',
    truncated_header: 'The clan crest request is incomplete.',
    truncated_data: 'The clan crest data is incomplete.',
    crest_too_large: 'The clan crest is too large.',
    clan_dissolving: 'The clan is currently being dissolved.',
    upload_failed: 'Failed to update the clan crest.'
};

function textFor(code, fallback = 'Clan action failed.') {
    return ERROR_TEXT[String(code || '')] || fallback;
}

function send(session, message) {
    if (!session?.dataSendToMe || !message) return;
    session.dataSendToMe(ServerResponse.systemMessage.text(message));
}

function failure(session, code, fallback) {
    send(session, textFor(code, fallback));
}

module.exports = { send, failure, textFor };
