'use strict';

// One durable encounter owns both parties, so HP, regeneration, admission and
// rewards have one writer. Party skills still see groups of at most nine.
const id = value => Number(value?.characterId ?? value?.actor?.fetchId?.() ?? value?.fetchId?.() ?? value?.id ?? value);
const markerFor = value => value?.stats?.objective?.fullRoster || value?.fullRoster || value;
const coreIds = value => {
    const marker = markerFor(value);
    return marker?.coreMemberIds || marker?.memberIds || [];
};
// PARTY_MEMBERS: a C4 party's nine. MAX_MEMBERS: the most one background party row
// holds, an expedition's core party and its helpers' party. A row of up to eighteen
// is our expedition design: C4 has no party over nine. These own the size of a party
// row and of the party goal query's messages: its request pages and answer, the group
// purse, validGroups and capacity read them. Other places still write the number.
const PARTY_MEMBERS = 9, MAX_MEMBERS = 2 * PARTY_MEMBERS;
function validGroups(marker) {
    const all = marker?.memberIds, core = coreIds(marker);
    return Array.isArray(all) && Array.isArray(core) && core.length === PARTY_MEMBERS
        && all.length >= PARTY_MEMBERS && all.length <= MAX_MEMBERS && new Set(all).size === all.length
        && new Set(core).size === PARTY_MEMBERS && core.every(value => all.includes(value))
        && (all.length === PARTY_MEMBERS ? !marker.coreMemberIds : Array.isArray(marker.coreMemberIds));
}
function helper(value, member) {
    const marker = markerFor(value), memberId = id(member);
    return !!marker?.coreMemberIds && marker.memberIds.includes(memberId) && !marker.coreMemberIds.includes(memberId);
}
function groups(value) {
    const marker = markerFor(value), core = coreIds(marker);
    return marker?.coreMemberIds ? [core, marker.memberIds.filter(value => !core.includes(value))] : [core];
}
function partyMembers(members, value, member) {
    const marker = markerFor(value);
    if (!marker?.coreMemberIds) return members;
    const ids = groups(marker).find(group => group.includes(id(member))) || [];
    return members.filter(value => ids.includes(id(value)));
}
function capacity(value) {
    const marker = markerFor(value);
    return validGroups(marker) ? marker.memberIds.length : PARTY_MEMBERS;
}
function memberMarker(value) {
    const state = value?.coldLifeState || value?.session?.coldLifeState || value;
    return state?.stats?.clanPartyObjective?.fullRoster || state?.stats?.partyRequest?.fullRoster;
}
module.exports = { PARTY_MEMBERS, MAX_MEMBERS, id, markerFor, coreIds, helper, groups, validGroups, partyMembers, capacity, memberMarker };
