const SurvivalFloor = require('./SurvivalFloor');
const BotErrands = require('./BotErrands');
// A floor that unloads, as the bag's need.
const floorNeed = floor => floor?.action === 'unload'
    ? { ...floor, reason: floor.reason === 'no_slot' ? 'inventory_capacity' : 'inventory_overweight' } : null;
// lazy: worker ItemDisposition's own links are not loaded with the worker kernel.
const countNeed = (member, now) => invoke('GameServer/Bot/Economy/ItemDisposition').inventoryCleanupNeed(member, { now });
// The bag fact (DecisionSections.stateView: its rise raises bag_full):
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
// A return ticket still held: before its 15 minutes run out. Past them the party no longer
// waits for its member (pending drops it) and the member's next trip drops it
// (GoalExecutor.beginMarketTravel). A ticket with no time (until missing, 0, not a number)
// is held by neither: departure always writes one.
const held = (token, now) => Number(token?.until) > now;
function pending(party, now = Date.now()) {
    return Object.values(party?.stats?.marketAbsences || {}).filter(value => held(value, now));
}
// The trips a clan duty lets its member go on (its stay answered one,
// ColdSimulationKernel.partyStay, one absence at a time): an unload of a bag at its
// floor; a war lets none (no stay decision is taken at war).
const FLOOR_REASONS = ['inventory_capacity', 'inventory_overweight'];
// The unload goal of a member whose trip its stay answered. The native purchase/travel
// gate still checks its quote and cash.
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
// The party the ticket returns to still runs the errand its member left: a clan duty's
// goal, else (an ordinary party's warehouse trip) its objective.
function sameObjective(party, token) {
    return token?.cleanupReason === 'craft_warehouse'
        ? String(party?.stats?.objective?.objectiveKey || '') === String(token.objective?.objectiveKey || '')
        : party?.stats?.objective?.clanGoalKey === token?.objective?.clanGoalKey;
}
const sameTicket = (a, b) => String(a.partyId) === String(b.partyId) && a.startedAt === b.startedAt;
// A stay trip's departure and its one end, traced at the commit of its member's row that
// sets or clears the return ticket (BotLifeState's publication): every path that ends a trip
// writes that row (the return to its party, the wait for it, a visit's end with its party
// gone, a lost way back, a new trip over an expired ticket). The end: returned (in its party
// again), return_wait (waits for it, party_wait) or alone (goes on without it); its reason,
// what the party is at that commit: party_gone (no live row), party_hot (near the player),
// objective_changed, party_live. A ticket past its time ends as expired, with the end it
// found as the reason, and is counted (party:stay_trip:expired). Main only.
function traceCommitted(previous, state, now = Date.now()) {
    const before = previous.stats?.partyMarketReturn || null, after = state.stats?.partyMarketReturn || null;
    if (!before && !after || before && after && sameTicket(before, after)) return;
    // lazy: the worker loads this module without main's party rows; Situations links back here.
    const Trace = require('../DecisionTrace'), bot = Number(state.characterId);
    if (before) {
        const party = invoke('GameServer/Bot/Population/BackgroundPartyState').find(before.partyId);
        const end = String(state.party?.partyId || state.partyId || '') === String(before.partyId) ? 'returned'
            : state.activity === 'party_wait' ? 'return_wait' : 'alone';
        const cause = end === 'returned' ? undefined : !party ? 'party_gone' : party.status === 'hot' ? 'party_hot'
            : !sameObjective(party, before) ? 'objective_changed' : 'party_live';
        const expired = !held(before, now), startedAt = Number(before.startedAt);
        if (expired) require('../Situations').note('party:stay_trip:expired');
        Trace.record({ kind: 'party', bot, party: String(before.partyId), phase: 'stay_trip',
            outcome: expired ? 'expired' : end, reason: expired ? end : cause,
            durationMs: startedAt > 0 ? now - startedAt : undefined });
    }
    if (after) Trace.record({ kind: 'party', bot, party: String(after.partyId), phase: 'stay_trip', outcome: 'left',
        reason: after.cleanupReason });
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
module.exports = { bagNeed, bagFact, cleanupDecision, cleanupFree, heldCleanup, withoutStartedTrip, clanDuty, held, pending,
    goal, departure, sameObjective, traceCommitted, stats, ready, FLOOR_REASONS };
