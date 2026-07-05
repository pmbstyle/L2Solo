const ClanService = invoke('GameServer/Clan/ClanService');

function clanId(actor) {
    return Number(actor?.fetchClanId?.() || 0);
}

function clan(actor) {
    return ClanService.findById(clanId(actor));
}

function crestId(actor) {
    return Number(clan(actor)?.crestId || 0);
}

function largeCrestId(actor) {
    return Number(clan(actor)?.crestLargeId || 0);
}

function allyId(actor) {
    return Number(clan(actor)?.allyId || 0);
}

function allyCrestId(actor) {
    return Number(clan(actor)?.allyCrestId || 0);
}

function privileges(actor) {
    return Number(actor?.fetchClanPrivileges?.() || 0);
}

function memberOnlineObjectId(member) {
    return ClanService.onlineObjectId(member);
}

module.exports = {
    clan,
    clanId,
    crestId,
    largeCrestId,
    allyId,
    allyCrestId,
    privileges,
    memberOnlineObjectId
};
