// A clan hunt is a shared assignment, never permission to attempt it alone. A
// closed request (forming found no roster, its assembly gave up:
// PartyRequestPlanner.closed) hunts its own spot, not the clan's route, until its
// next build asks again.
const Planner = () => invoke('GameServer/Bot/Population/PartyRequestPlanner'); // lazy: the planner's chain reads this module
// The clan's call on the bot, whether or not its own request for it is closed.
function call(state) {
    const value = state?.stats?.clanPartyObjective;
    return value?.status === 'open' && value.clanGoalKey && value.priority === 'required' ? value : null;
}
function objective(state) {
    return Planner().closed(state) ? null : call(state);
}
// Only a bot forming may take waits for it (PartyRequestPlanner.formingSkips).
function waiting(state) {
    return !state?.party?.partyId && !state?.partyId && !Planner().formingSkips(state) && !!objective(state);
}
// The wait is published (hold below): the bot steps again only when a writer
// changes its row (ColdSimulationKernel lifecycleKind 'event_driven'): its party
// (BotLifeState.preparePartyAssignment), the objective's end or a cooldown.
function held(state) {
    const goal = waiting(state) && objective(state);
    return !!goal && state.activity === 'party_wait' && state.stats.eventWait === 'clan_party_assembly'
        && state.stats.partyRequest?.clanGoalKey === goal.clanGoalKey;
}
function hold(state, timestamp) {
    return { patch: { activity: 'party_wait', stats: { ...state.stats, partyRequest: objective(state),
        lastReason: 'clan_party_assembly' } }, events: [], eventWait: 'clan_party_assembly',
        // Held, the bot takes no step; the change that ends the wait steps it at
        // once (ColdSimulationKernel.upsert). The hold has no due of its own: a
        // command that holds the bot first (lifecycleKind) runs at once, and the
        // write that ends it leaves the bot held again.
        materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp,
        debug: { activity: 'clan_party_assembly', fights: 0, wins: 0 } };
}
// A clan member the call no longer holds hunts its own spot again; the call stays
// for a later build. Either it buys on the market or serves a shop (formingSkips:
// its request is dropped), or its request for the call closed (the closed request
// is kept until its next build). A closed call's equipment plan goes with it, waiter
// or not: the clan's route is a party's, never a solo hunt (the clan keeps the goal
// and assigns the plan again at its review after the member's next build).
function released(state) {
    if (state?.party?.partyId || state?.partyId || waiting(state)) return false;
    const goal = call(state);
    return !!goal && (state.activity === 'party_wait'
        || Planner().closed(state) && state.stats.equipmentPlan?.clanGoal?.goalKey === goal.clanGoalKey);
}
function release(state, timestamp) {
    const stats = { ...state.stats }, goalKey = call(state).clanGoalKey;
    if (Planner().closed(state)) {
        if (stats.equipmentPlan?.clanGoal?.goalKey === goalKey) delete stats.equipmentPlan;
    } else if (stats.partyRequest?.clanGoalKey === goalKey) delete stats.partyRequest;
    return { patch: { activity: 'hunting', stats }, events: [],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp,
        debug: { activity: 'clan_party_released', fights: 0, wins: 0 } };
}
module.exports = { objective, waiting, held, hold, released, release };
