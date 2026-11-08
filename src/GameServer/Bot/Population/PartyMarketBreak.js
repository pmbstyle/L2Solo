const SurvivalFloor = require('./SurvivalFloor');
const BotErrands = require('./BotErrands');
// A floor that unloads, as the bag's need.
const floorNeed = floor => floor?.action === 'unload'
    ? { ...floor, reason: floor.reason === 'no_slot' ? 'inventory_capacity' : 'inventory_overweight' } : null;
// lazy: worker ItemDisposition's own links are not loaded with the worker kernel.
const countNeed = (member, now) => invoke('GameServer/Bot/Economy/ItemDisposition').inventoryCleanupNeed(member, { now });
// The bag fact (situations.md F2; DecisionSections.stateView: its rise raises bag_full):
// what the bag holds, read without a price, the board or the clock. 2 at the slot or
// weight floor (SurvivalFloor.bagFloor), 1 at a cleanup count (ItemDisposition.cleanupCounted),
// else 0. Whether the bag goes to town, and what it sells, is the build's (cleanupDecision).
// kitHashes: the state's kit events when the caller holds them.
function bagFact(state, kitHashes = null) {
    if (SurvivalFloor.bagFloor(state, kitHashes)?.action === 'unload') return 2;
    // lazy: worker ItemDisposition's own links are not loaded with the worker kernel.
    return Number(invoke('GameServer/Bot/Economy/ItemDisposition').cleanupCounted(state));
}
// The build's cleanup decision, one rule for both threads (EconomyContext: a far step's
// build, a near body's): a solo bot's bag must go to town. At its floor (bag fact 2: no
// slot, overweight) it leaves, whatever the sale retry says (the floor is survival, and
// a retry held there would hold the trip with nothing to wake the build again); at a
// cleanup count (1) the author's thresholds with the sale retry read now
// (inventoryCleanupNeed), whose hold ends when the fact rises to its floor (bag_full).
// At 0 (no floor, no cleanup count) nothing: the sale walk runs only for a counted bag.
// Held in stats.cleanupDue until its trip starts (the far kernel's step with
// main's cleanup goal, a body's HuntingState) or the bag fact falls to 0.
function cleanupDecision(state, now) {
    return state.party?.partyId || state.partyId ? null : bagNeed(state, now);
}
// The bag's need to go sell, read from the bag fact, one rule for a solo bot's build
// (cleanupDecision) and a party member's stay and its duty trip (PartyStay): the floor
// (fact 2: no slot, overweight) whatever the sale retry, else the cleanup count's reason
// (fact 1). A party member's count has no half-full line and no sale retry
// (inventoryCleanupNeed reads them for a solo bot only). { reason, slots, limit } or null.
function bagNeed(state, now) {
    const fact = bagFact(state);
    return fact === 2 ? floorNeed(SurvivalFloor.bagFloor(state)) : fact === 1 ? countNeed(state, now) : null;
}
const CLEANUP_BUSY_FLAGS = ['marketReturn'];
const CLEANUP_BUSY_ACTIVITIES = ['traveling', 'shopping', 'merchant', 'crafting', 'dead', 'pk_hunting'];
// A solo cold bot with no trip or errand under way: free to start a cleanup trip.
function cleanupFree(state) {
    return !!state && state.phase === 'cold' && !(state.party?.partyId || state.partyId)
        && !state.stats?.travel && !BotErrands.busyWith(state, CLEANUP_BUSY_FLAGS)
        && !CLEANUP_BUSY_ACTIVITIES.includes(state.activity);
}
// The bag's trip the build decided (stats.cleanupDue, cleanupDecision), for a bot free to
// start it: main's resolves start only this trip, they never weigh the bag themselves.
function heldCleanup(state) {
    return cleanupFree(state) ? state.stats?.cleanupDue || null : null;
}
// A forced cleanup decided over a resolve outranks a trip that resolve
// started (route, karma), as it did when it was decided before the fight;
// the fight's outcome is kept.
function withoutStartedTrip(before, resolved) {
    if (before.activity === 'traveling' || resolved.activity !== 'traveling') return resolved;
    return { ...resolved, activity: before.activity, stats: { ...(resolved.stats || {}), travel: null } };
}
const cleanupGoal = (need) => invoke('GameServer/Bot/Goals/NeedsEvaluator').cleanupGoal(need);

const RESERVATION_MS = 15 * 60 * 1000;
function clanDuty(party) {
    const objective = party?.stats?.objective;
    return objective?.priority === 'required' && !!objective.clanGoalKey;
}
// The order owns the roster through its physical return, even after expiry.
const warDuty = party => !!party?.stats?.warOperation;
function pending(party, now = Date.now()) {
    return Object.values(party?.stats?.marketAbsences || {}).filter(value => Number(value.until) > now);
}
// The trips a clan duty lets its member go on (its stay answered one,
// ColdSimulationKernel.partyStay): an unload of a bag at its floor, one absence at a
// time; a war or any other party lets none (no stay decision is taken at war).
const FLOOR_REASONS = ['inventory_capacity', 'inventory_overweight'];
function allowed(party, member, now = Date.now(), need = undefined) {
    if (warDuty(party) || !clanDuty(party) || pending(party, now).length) return false;
    return FLOOR_REASONS.includes((need === undefined ? bagNeed(member, now) : need)?.reason);
}
// The unload goal of a member allowed its trip. The native purchase/travel gate
// still checks its quote and cash.
function goal(party, member, now, need = undefined) {
    const bag = need === undefined ? bagNeed(member, now) : need;
    return FLOOR_REASONS.includes(bag?.reason) ? { ...cleanupGoal(bag), status: 'active' } : null;
}
// The allowed member's trip with its return ticket: the party holds its place until
// it comes back (PopulationService.resumePartyMarketBreak) or the ticket expires.
function departure(party, member, travel, now, given = undefined) {
    const need = given === undefined ? bagNeed(member, now) : given;
    const token = { partyId: party.partyId, characterId: member.characterId, until: now + RESERVATION_MS,
        objective: { ...party.stats.objective }, startedAt: now, cleanupReason: need?.reason,
        slots: need?.slots, limit: need?.limit };
    return { ...travel, stats: { ...travel.stats, partyMarketReturn: token, clanPartyObjective: token.objective } };
}
function stats(party, departed) {
    const token = departed?.stats?.partyMarketReturn;
    return token ? { marketAbsences: { ...party.stats?.marketAbsences, [departed.characterId]: token } } : {};
}
function ready(state) {
    return !!state?.stats?.partyMarketReturn && !state.party?.partyId && !state.partyId
        && !state.stats?.travel && !state.stats?.marketReturn
        && ['hunting', 'party_wait', 'grouped'].includes(state.activity);
}
module.exports = { bagNeed, bagFact, cleanupDecision, cleanupFree, heldCleanup, withoutStartedTrip, clanDuty, warDuty, pending,
    allowed, goal, departure, stats, ready, FLOOR_REASONS };
