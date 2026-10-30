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
function declaration(clan, target, outgoingCount = 0, { manual = false, replying = false } = {}) {
    if (!clan || !target) return 'clan_not_found';
    if (clan.id === target.id) return 'own_clan';
    if (clan.dissolvingExpiryTime > 0 || target.dissolvingExpiryTime > 0) return 'clan_dissolving';
    if (clan.allyId > 0 && clan.allyId === target.allyId) return 'same_alliance';
    if (clan.level < MIN_LEVEL || target.level < MIN_LEVEL) return 'clan_level';
    // Player commands do not need a full roster. A bot answering an existing
    // declaration still needs its own roster, but may answer a small player clan.
    if (!manual && (clan.members < MIN_MEMBERS || !replying && target.members < MIN_MEMBERS)) return 'clan_members';
    if (outgoingCount >= MAX_DECLARATIONS) return 'war_limit';
    return null;
}
module.exports = { MIN_LEVEL, MIN_MEMBERS, MAX_DECLARATIONS, CLAN_WAR_PRIVILEGE, id, key, pairKey, relation, declaration };
