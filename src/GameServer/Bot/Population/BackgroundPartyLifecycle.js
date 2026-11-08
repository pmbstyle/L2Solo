const { REASON: ASSEMBLY_TIMEOUT } = require('./PartyHuntingAssembly');
const RaidSoloBoundary = require('./RaidSoloBoundary');
const Situations = require('../Situations');
const Trace = require('../DecisionTrace');

function raidStarted(party) {
    const objective = party?.stats?.objective;
    if (party?.status === 'dissolved' || party?.stats?.raidEncounter?.status === 'failed') return false;
    if (party?.stats?.objective?.opportunisticRaid === true) return true;
    return (objective?.sourceKind === 'raid' || objective?.raidBoss === true)
        && (['preparing', 'ready'].includes(party?.stats?.raidPreparation?.status)
            || party?.stats?.raidEncounter?.status === 'active');
}

// The party's clan objective ends a step reads (temporary: until the clan raises its own
// situations): a raid the party walked away from, or a member its clan or raid objective
// no longer admits, leaves. { leaving: Map(id -> reason) }.
function objectiveEnds(party, members) {
    const leaving = new Map(), objective = party.stats?.objective;
    const Clan = require('./ClanEquipmentPartyPolicy');
    if (Clan.needsReview(party, members)) {
        const abandoned = Clan.abandonedRaid(party);
        for (const member of members) {
            if (abandoned) leaving.set(Number(member.characterId), 'raid_failed');
            else if (!Clan.allowed(member, objective)) leaving.set(Number(member.characterId), 'clan_party_unsafe');
        }
    }
    return { leaving };
}

// The one leave rule (every path a member leaves its party by: a worker step, main's
// leaveParty, a hot lifecycle): the member's solo state. A grouped member, or one on
// the party's road, resumes its own hunt (grouped and the party's trip are no solo
// states); a weapon or armour bridge sends it hunting at once to buy it. A far member
// (a cold row) hears party_left here, on the stats its leave writes: its earning spot
// and build wake (a hot body hears it through its own raise, HotPartyLifecycle).
function releaseMember(state, timestamp = Date.now(), reason = 'party_session_rotation', objective = null) {
    if (!state?.characterId) return state;

    const raidRelease = RaidSoloBoundary.stale(state, objective);
    if (raidRelease) state = RaidSoloBoundary.clear(state);
    const partyTravel = state.stats?.travel?.reason === 'party_spot_replan';
    const equipmentBridge = ['weapon_bridge', 'class_armor_bridge'].includes(reason);
    const resumes = equipmentBridge || state.activity === 'grouped' || partyTravel;
    const stats = {
        ...(state.stats || {}),
        ...(partyTravel ? { travel: null } : {}),
        backgroundPartyId: null,
        partyBreakReason: reason,
        ...(reason === 'clan_party_unsafe' ? { clanPartyObjective: null } : {}),
        partyRequest: !raidRelease && (reason === ASSEMBLY_TIMEOUT
            || reason === 'party_material_route_unavailable' && objective)
            ? { ...(objective || {}), status: 'closed', lastReason: reason, requestedAt: timestamp }
            : null
    };
    const next = {
        ...state,
        activity: resumes ? 'hunting' : state.activity,
        party: { ...(state.party || {}), partyId: null, leaderId: null },
        stats,
        timing: resumes
            ? { ...(state.timing || {}), activityStartedAt: timestamp,
                nextResolveAt: timestamp + (equipmentBridge ? 1000 : 30000) }
            : state.timing,
        updatedAt: timestamp
    };
    // A request its leave closes (an assembly that timed out, a material route gone) is traced as forming's close is.
    if (stats.partyRequest && Trace.on()) Trace.record({ kind: 'party', bot: Number(state.characterId), phase: 'request',
        outcome: 'closed', reason });
    if (state.phase === 'cold') Situations.raise(stats, 'party_left', null, Situations.place(next), Number(state.characterId));
    // A solo bot holds no stay (its stay is answered by the leave), nor a party's XP
    // share exclusion (stats.partyOutleveled: its next party raises its own flip).
    Situations.leftParty(stats, Number(state.characterId));
    if (stats.partyOutleveled) stats.partyOutleveled = 0;
    return next;
}

// The party's roster after its members' leaves (leaving: Map(id -> reason), the party
// step's: their stays, its objective's ends): each leaver released by the one leave
// rule, the rest re-led; under the party's minimum it dissolves and all leave
// (party_min_size). options: { partyMinSize, chooseLeader(states), roleCoverage(states) }.
// Returns { party, states, leaving }.
function release(party, members, leaving, timestamp, options = {}) {
    leaving = new Map(leaving);
    let retained = members.filter(s => !leaving.has(Number(s.characterId)));
    const dissolved = retained.length < Math.max(2, Number(options.partyMinSize) || 2);
    if (dissolved) {
        members.forEach(s => { if (!leaving.has(Number(s.characterId))) leaving.set(Number(s.characterId), 'party_min_size'); });
        retained = [];
    }
    const leaderId = retained.find(s => s.characterId === party.leaderId)?.characterId
        || (options.chooseLeader?.(retained) || retained[0])?.characterId || party.leaderId;
    const nextResolveAt = Math.max(timestamp + 1000, Number(party.nextResolveAt || 0));
    const Material = require('./CraftMaterialParty');
    const states = members.map(s => leaving.has(Number(s.characterId))
        ? releaseMember(s, timestamp, leaving.get(Number(s.characterId)), Material.isObjective(party.stats?.objective)
            && leaving.get(Number(s.characterId)) === ASSEMBLY_TIMEOUT
            ? Material.departureRequest(party, s) : party.stats?.objective)
        : { ...s, party: { ...s.party, leaderId }, stats: { ...s.stats, leaderId },
            timing: { ...s.timing, nextResolveAt } });
    const nextParty = { ...party, status: dissolved ? 'dissolved' : party.status || 'active',
        memberIds: retained.map(s => s.characterId), leaderId, nextResolveAt: dissolved ? null : nextResolveAt,
        roleCoverage: options.roleCoverage?.(retained) || party.roleCoverage,
        stats: { ...party.stats, ...(dissolved ? { partyBreakReason: 'party_min_size' } : {}) } };
    return { party: nextParty, states, leaving };
}

module.exports = {
    raidStarted,
    objectiveEnds,
    release,
    releaseMember
};
