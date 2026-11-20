'use strict';

// One durable encounter owns all parties, so HP, regeneration, admission and
// rewards have one writer. Party skills still see groups of at most nine.
const id = value => Number(value?.characterId ?? value?.actor?.fetchId?.() ?? value?.fetchId?.() ?? value?.id ?? value);
const markerFor = value => value?.stats?.objective?.fullRoster || value?.fullRoster || value;
const coreIds = value => {
    const marker = markerFor(value);
    return marker?.coreMemberIds || marker?.memberIds || [];
};
// One background row owns the expedition. Ordinary C4 party skills still see
// nine members; the expedition can hold the largest C4 clan, including a final
// incomplete helper party. Transport and persistence use this same bound.
const PARTY_MEMBERS = 9, MAX_MEMBERS = 40;
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
    if (!marker?.coreMemberIds) return [core];
    const helpers = marker.memberIds.filter(value => !core.includes(value));
    const result = [core];
    for (let offset = 0; offset < helpers.length; offset += PARTY_MEMBERS) result.push(helpers.slice(offset, offset + PARTY_MEMBERS));
    return result;
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
