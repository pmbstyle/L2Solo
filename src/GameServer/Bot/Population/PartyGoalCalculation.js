'use strict';
const Sections = require('../Economy/DecisionSections');

// Complete group inputs are process-local. Only source versions and the joint
// policy's small stats packet cross back to the main thread.
function source(state) {
    return { characterId: Number(state.characterId),
        updatedAt: Number(state.updatedAt || 0), phase: state.phase,
        partyId: Sections.partyIdOf(state),
        revision: Number(state.simulation?.revision || 0) };
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
    const capacity = require('../../Clan/ClanRaidExpedition').capacity(party);
    return !!party && Array.isArray(members) && members.length > 0 && members.length <= capacity
        && new Set(members.map(state => state?.characterId)).size === members.length
        && members.every(state => Number.isSafeInteger(state?.characterId) && state.characterId > 0
            && ['cold', 'hot'].includes(state.phase) && Number.isFinite(Number(state.updatedAt || 0)))
        && Array.isArray(party.memberIds) && party.memberIds.length > 0 && party.memberIds.length <= capacity
        && new Set(party.memberIds).size === party.memberIds.length
        && party.memberIds.every(id => Number.isSafeInteger(id) && id > 0)
        && members.every(state => party.memberIds.includes(state.characterId))
        && (partial || party.memberIds.length === members.length)
        && party.memberIds.includes(party.leaderId) && typeof party.partyId === 'string' && !!party.partyId;
}

// A forming roster (main's `stats.forming`, before the party is built) gets only its verdict,
// PartyGoalPolicy.formingVerdict: the accepted ids, no goals.
// bridgeReason: the thread's funded-bridge read (PartyStay.joins), for a forming verdict.
async function calculate(party, members, prepare, timestamp, current = () => true, { spots, bridgeReason = null } = {}) {
    if (party.stats?.forming) {
        if (!current()) throw new Error('party_goal_expired');
        // lazy: optional the joint policy loads only for a goal or recruit check
        return require('./PartyGoalPolicy').formingVerdict(members, party.stats.forming.requested || null, { spots, timestamp, bridgeReason });
    }
    if (require('./OpportunisticRaidPolicy').isObjective(party.stats?.objective)) {
        if (!current()) throw new Error('party_goal_expired');
        const objective = party.stats.objective;
        const wall = performance.now(), cpu = process.threadCpuUsage?.();
        const catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
        const assessmentOptions = {
                timestamp, maxFightSeconds: objective.maxFightSeconds, reserve: objective.shotReserve,
                fundSupplies: objective.fundRaidSupplies === true };
        const raidAssessment = objective.raidCandidateIds?.length
            ? require('./RaidTargetSelection').assess(members,
                objective.raidCandidateIds.map(id => catalog.findById(`raid:${id}`)).filter(Boolean), assessmentOptions)
            : require('./OpportunisticRaidPolicy').assessment(members, catalog.findById(objective.spotId), assessmentOptions);
        const used = cpu && process.threadCpuUsage(cpu);
        // Charge only synchronous forecast work on this worker thread. Queue
        // waits and other server threads must not inflate the search budget.
        raidAssessment.workMs = used ? (used.user + used.system) / 1000 : performance.now() - wall;
        return { ...require('./PartyGoalPolicy').pending(party, members), raidAssessment };
    }
    // Declared material needs do not require personal or group wish rebuilds.
    if (require('./CraftMaterialParty').isObjective(party.stats?.objective)) {
        if (!current()) throw new Error('party_goal_expired');
        return require('./PartyGoalPolicy').joint(party, members);
    }
    const contexts = [];
    for (const member of members) {
        if (!current()) throw new Error('party_goal_expired');
        contexts.push(await prepare(member, timestamp));
        if (!current()) throw new Error('party_goal_expired');
    }
    const policy = require('./PartyGoalPolicy');
    const context = policy.groupContext(party, members, { timestamp, memberContexts: contexts, rememberGroup: false });
    return policy.joint(party, members, { context });
}

// The recruit check of a pending join: the members with the recruits on one
// prospective roster, one income and safety forecast each (the author's
// PartyGoalPolicy.recruitment). The join is the answer only when every
// required member accepts; null otherwise. Runs where the party steps: the
// leader's step in the background thread, or main for a party near the player.
// bridgeReason: the thread's funded-bridge read (PartyStay.joins).
function recruitCheck(party, members, { spots, timestamp, bridgeReason = null }) {
    // lazy: optional material rules load only for a recruit check (this file loads with the protocol)
    const Material = require('./CraftMaterialParty');
    // lazy: optional gear rules (item data) load only for a recruit check
    const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
    const objective = party.stats?.objective || null;
    const material = Material.isObjective(objective);
    const agreement = material ? Material.agreement(members, objective, party.stats.agreement) : party.stats?.agreement;
    const roster = { ...party, memberIds: members.map(member => Number(member.characterId)),
        stats: { ...(party.stats || {}), agreement } };
    // lazy: optional the joint policy loads only for a goal or recruit check
    const joint = require('./PartyGoalPolicy').recruitment(roster, members, { spots, timestamp });
    // A recruit whose own stay would leave at once is no join (PartyStay.joins).
    const current = new Set((party.memberIds || []).map(Number));
    const refused = members.some(member => (material ? Progression.adventurer(member) : Progression.personal(member))
        && !joint.progressReviews.find(row => row.characterId === Number(member.characterId))?.accept)
        || members.some(member => !current.has(Number(member.characterId))
            && !require('./PartyStay').joins(member, { now: timestamp, bridgeReason }));
    return refused ? null : { objective: joint.objective, memberGoals: joint.memberGoals, agreement: agreement || null };
}

module.exports = { source, sources, sameSource, matches, validMembers, calculate, recruitCheck };
