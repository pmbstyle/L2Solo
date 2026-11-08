'use strict';

const MIN_LEVEL = 3, MIN_MEMBERS = 15, MAX_DECLARATIONS = 30;
const CLAN_WAR_PRIVILEGE = 1024;
const id = value => Number.isSafeInteger(value) && value > 0;
const key = (from, to) => `${from}:${to}`;
const pairKey = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;
function relation(outgoing, incoming) {
    const sent = outgoing?.active === 1, received = incoming?.active === 1;
    return { outgoing: sent, incoming: received, mutual: sent && received,
        revision: Math.max(outgoing?.revision || 0, incoming?.revision || 0),
        status: sent && received ? 'mutual' : sent ? 'outgoing' : received ? 'incoming' : 'neutral' };
}
// Why a clan may not wage war on its own side (C4: level 3, a full roster, not
// dissolving); a player command needs no full roster. The one owner of these checks:
// a declaration asks it for both clans, the war review for its own.
function refusal(clan, members, manual = false) {
    if (clan.dissolvingExpiryTime > 0) return 'clan_dissolving';
    if (Number(clan.level) < MIN_LEVEL) return 'clan_level';
    if (!manual && members < MIN_MEMBERS) return 'clan_members';
    return null;
}
// `members` on both clans is the roster count. A bot answering an existing
// declaration still needs its own roster, but may answer a small player clan.
function declaration(clan, target, outgoingCount = 0, { manual = false, replying = false } = {}) {
    if (!clan || !target) return 'clan_not_found';
    if (clan.id === target.id) return 'own_clan';
    if (clan.allyId > 0 && clan.allyId === target.allyId) return 'same_alliance';
    return refusal(clan, clan.members, manual) || refusal(target, target.members, manual || replying)
        || (outgoingCount >= MAX_DECLARATIONS ? 'war_limit' : null);
}
// A clan C4 lets wage war on its own (declare, or answer a declaration as a bot).
const canWage = (clan, members) => !!clan && !refusal(clan, members);
module.exports = { MIN_LEVEL, MIN_MEMBERS, MAX_DECLARATIONS, CLAN_WAR_PRIVILEGE, id, key, pairKey, relation, declaration, canWage };
