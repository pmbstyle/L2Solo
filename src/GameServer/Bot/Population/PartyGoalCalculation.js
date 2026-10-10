'use strict';

// Complete group inputs are process-local. Only source versions and the joint
// policy's small stats packet cross back to the main thread.
function source(state) {
    return { characterId: Number(state.characterId),
        updatedAt: Number(state.updatedAt || 0), phase: state.phase,
        partyId: String(state.party?.partyId || state.partyId || ''),
        ownerId: String(state.simulation?.ownerId || 'legacy_main'),
        revision: Number(state.simulation?.revision || 0),
        leaseId: String(state.simulation?.leaseId || '') };
}

function sources(members) {
    return members.map(source);
}

// Two snapshots of one actor with the same source identity are the same input.
function sameSource(left, right) {
    const a = source(left), b = source(right);
    for (const key in a) if (a[key] !== b[key]) return false;
    return true;
}

function matches(members, expected) {
    return JSON.stringify(sources(members)) === JSON.stringify(expected);
}

function validMembers(party, members, partial = false) {
    return !!party && Array.isArray(members) && members.length > 0 && members.length <= 9
        && new Set(members.map(state => state?.characterId)).size === members.length
        && members.every(state => Number.isSafeInteger(state?.characterId) && state.characterId > 0
            && ['cold', 'hot'].includes(state.phase) && Number.isFinite(Number(state.updatedAt || 0)))
        && Array.isArray(party.memberIds) && party.memberIds.length > 0 && party.memberIds.length <= 9
        && new Set(party.memberIds).size === party.memberIds.length
        && party.memberIds.every(id => Number.isSafeInteger(id) && id > 0)
        && members.every(state => party.memberIds.includes(state.characterId))
        && (partial || party.memberIds.length === members.length)
        && party.memberIds.includes(party.leaderId) && typeof party.partyId === 'string' && !!party.partyId;
}

async function calculate(party, members, prepare, timestamp, current = () => true, { spots } = {}) {
    const contexts = [];
    for (const member of members) {
        if (!current()) throw new Error('party_goal_expired');
        contexts.push(await prepare(member, timestamp));
        if (!current()) throw new Error('party_goal_expired');
    }
    const policy = require('./PartyGoalPolicy');
    const context = policy.groupContext(party, members, { timestamp, memberContexts: contexts, rememberGroup: false });
    return policy.joint(party, members, { context, timestamp, memberContexts: contexts, spots });
}

module.exports = { sources, sameSource, matches, validMembers, calculate };
