'use strict';

// One durable encounter owns both parties, so HP, regeneration, admission and
// rewards have one writer. Party skills still see groups of at most nine.
const id = value => Number(value?.characterId ?? value?.actor?.fetchId?.() ?? value?.fetchId?.() ?? value?.id ?? value);
const markerFor = value => value?.stats?.objective?.fullRoster || value?.fullRoster || value;
const coreIds = value => {
    const marker = markerFor(value);
    return marker?.coreMemberIds || marker?.memberIds || [];
};
function validGroups(marker) {
    const all = marker?.memberIds, core = coreIds(marker);
    return Array.isArray(all) && Array.isArray(core) && core.length === 9
        && all.length >= 9 && all.length <= 18 && new Set(all).size === all.length
        && new Set(core).size === 9 && core.every(value => all.includes(value))
        && (all.length === 9 ? !marker.coreMemberIds : Array.isArray(marker.coreMemberIds));
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
    return validGroups(marker) ? marker.memberIds.length : 9;
}
function memberMarker(value) {
    const state = value?.coldLifeState || value?.session?.coldLifeState || value;
    return state?.stats?.clanPartyObjective?.fullRoster || state?.stats?.partyRequest?.fullRoster;
}
module.exports = { id, markerFor, coreIds, helper, groups, validGroups, partyMembers, capacity, memberMarker };
