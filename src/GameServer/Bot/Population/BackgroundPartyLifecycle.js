const AssemblyRecovery = require('./PartyAssemblyRecovery');
const RaidSoloBoundary = require('./RaidSoloBoundary');

function raidStarted(party) {
    const objective = party?.stats?.objective;
    if (party?.status === 'dissolved' || party?.stats?.raidEncounter?.status === 'failed') return false;
    if (party?.stats?.objective?.opportunisticRaid === true) return true;
    return (objective?.sourceKind === 'raid' || objective?.raidBoss === true)
        && (['preparing', 'ready'].includes(party?.stats?.raidPreparation?.status)
            || party?.stats?.raidEncounter?.status === 'active');
}

// members: the party's current states (the review's input key reads them);
// options: the review's (PartySessionReview: relationFlags). A party with
// no review yet records its evidence on its next resolve (baseline).
function sessionExpired(party, timestamp = Date.now(), options = {}, members = null) {
    if (party.stats?.warOperation) return false;
    if (AssemblyRecovery.expired(party) && !party?.stats?.travel
        && Number(party?.stats?.restUntil || 0) <= timestamp
        && !require('./PartyMarketBreak').pending(party, timestamp).length) return true;
    if (raidStarted(party)) return false;
    if (!party?.stats?.sessionReview) return false;
    return require('./PartySessionReview').due(party, members, timestamp, options);
}

// A new party's first review record, carried by its first resolve's party row
// (no review step, no departure): the evidence and clocks from which later
// reviews count, its inputs' key. A departure or a recovered assembly the
// evidence already shows is due at the next step, as a review.
function baseline(party, members, timestamp, options = {}) {
    const Review = require('./PartySessionReview');
    const result = Review.assess(party, members, timestamp, options);
    const now = result.decisions.some(decision => decision.leave) || result.assemblyRecovered || result.objectiveDone;
    return { ...result.review, decisions: [], key: Review.inputKey(party, members, options, timestamp),
        nextAt: now ? timestamp : result.review.nextAt };
}

function releaseMember(state, timestamp = Date.now(), reason = 'party_session_rotation', objective = null) {
    if (!state?.characterId) return state;

    const raidRelease = RaidSoloBoundary.stale(state, objective);
    if (raidRelease) state = RaidSoloBoundary.clear(state);
    const partyTravel = state.stats?.travel?.reason === 'party_spot_replan';
    const releasedFromObjective = raidRelease || [
        AssemblyRecovery.REASON, 'party_session_rotation', 'clan_priority',
        'party_min_size', 'clan_party_unsafe', 'craft_materials_collected', 'party_material_route_unavailable',
        'invalid_party_size',
        'party_membership_mismatch',
        'party_relationship_conflict', 'party_goals_diverged', 'party_no_progress', 'party_no_experience',
        'party_review_min_size', 'weapon_bridge', 'class_armor_bridge', 'raid_failed', 'raid_defeated', 'raid_unavailable'
    ].includes(reason);
    const equipmentBridge = ['weapon_bridge', 'class_armor_bridge'].includes(reason);
    const nextActivity = equipmentBridge
        ? 'hunting'
        : releasedFromObjective && (state.activity === 'grouped' || partyTravel)
            ? 'hunting'
            : state.activity;

    return {
        ...state,
        activity: nextActivity,
        party: { ...(state.party || {}), partyId: null, leaderId: null },
        stats: {
            ...(state.stats || {}),
            ...(partyTravel ? { travel: null } : {}),
            backgroundPartyId: null,
            partyBreakReason: reason,
            ...(reason === 'clan_party_unsafe' ? { clanPartyObjective: null } : {}),
            partyRequest: !raidRelease && (reason === AssemblyRecovery.REASON
                || reason === 'party_material_route_unavailable' && objective)
                ? { ...(objective || {}), status: 'closed', lastReason: reason, requestedAt: timestamp }
                : null
        },
        timing: releasedFromObjective && nextActivity === 'hunting'
            ? { ...(state.timing || {}), activityStartedAt: timestamp,
                nextResolveAt: timestamp + (equipmentBridge ? 1000 : 30000) }
            : state.timing,
        updatedAt: timestamp
    };
}

function review(party, members, timestamp, options = {}) {
    const result = require('./PartySessionReview').assess(party, members, timestamp, options);
    const leaving = new Map(result.decisions.filter(d => d.leave).map(d => [d.characterId, d.reason]));
    let retained = members.filter(s => !leaving.has(s.characterId));
    const dissolved = retained.length < Math.max(2, Number(options.partyMinSize) || 2);
    if (dissolved) {
        members.forEach(s => { if (!leaving.has(s.characterId)) leaving.set(s.characterId, 'party_review_min_size'); });
        retained = [];
    }
    const leaderId = retained.find(s => s.characterId === party.leaderId)?.characterId
        || (options.chooseLeader?.(retained) || retained[0])?.characterId || party.leaderId;
    const nextResolveAt = Math.max(timestamp + 1000, Number(party.nextResolveAt || 0));
    const Material = require('./CraftMaterialParty');
    const states = members.map(s => leaving.has(s.characterId)
        ? releaseMember(s, timestamp, leaving.get(s.characterId), Material.isObjective(party.stats?.objective)
            && leaving.get(s.characterId) === AssemblyRecovery.REASON
            ? Material.departureRequest(party, s) : party.stats?.objective)
        : { ...s, party: { ...s.party, leaderId }, stats: { ...s.stats, leaderId },
            timing: { ...s.timing, nextResolveAt } });
    const nextParty = { ...party, status: dissolved ? 'dissolved' : party.status || 'active',
        memberIds: retained.map(s => s.characterId), leaderId, nextResolveAt: dissolved ? null : nextResolveAt,
        roleCoverage: options.roleCoverage?.(retained) || party.roleCoverage,
        stats: { ...party.stats, ...(result.assemblyRecovered ? { assemblyWait: null } : {}),
            ...(result.objectiveDone ? { objective: null } : {}),
            sessionReview: result.review,
            ...(dissolved ? { partyBreakReason: 'party_review_min_size' } : {}) } };
    // The inputs this review stands on: the roster that stays, as it stays.
    if (!dissolved) nextParty.stats.sessionReview = { ...result.review, key: require('./PartySessionReview')
        .inputKey(nextParty, states.filter(s => !leaving.has(s.characterId)), options, timestamp) };
    return { party: nextParty, states, leaving, decisions: result.decisions };
}

module.exports = {
    raidStarted,
    sessionExpired,
    baseline,
    review,
    releaseMember
};
