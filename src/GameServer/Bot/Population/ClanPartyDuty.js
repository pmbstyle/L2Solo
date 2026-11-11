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
// A clan waiter the call no longer holds is released once: it hunts its own spot
// and the clan keeps its call for a later build. Either it buys on the market or
// serves a shop (formingSkips: its request is dropped), or its request for the
// call closed (the closed request is kept until its next build). The equipment
// plan is the clan's: only the clan's goal review writes or drops it, and the
// hunt's own spot choice keeps the clan's route out of a solo hunt.
function released(state) {
    if (state?.party?.partyId || state?.partyId || waiting(state)) return false;
    return !!call(state) && state.activity === 'party_wait';
}
function release(state, timestamp) {
    const stats = { ...state.stats }, goalKey = call(state).clanGoalKey;
    if (!Planner().closed(state) && stats.partyRequest?.clanGoalKey === goalKey) delete stats.partyRequest;
    return { patch: { activity: 'hunting', stats }, events: [],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp,
        debug: { activity: 'clan_party_released', fights: 0, wins: 0 } };
}
module.exports = { objective, waiting, held, hold, released, release };
