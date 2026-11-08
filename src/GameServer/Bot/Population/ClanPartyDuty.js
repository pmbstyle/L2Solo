// A clan hunt is a shared assignment, never permission to attempt it alone. A
// closed request (its assembly gave up: PartyRequestPlanner.closed) hunts solo
// until its next build asks again.
function objective(state) {
    if (invoke('GameServer/Bot/Population/PartyRequestPlanner').closed(state)) return null; // lazy: the planner's chain reads this module
    const value = state?.stats?.clanPartyObjective;
    return value?.status === 'open' && value.clanGoalKey && value.priority === 'required' ? value : null;
}
function waiting(state) {
    return !state?.party?.partyId && !state?.partyId && !!objective(state);
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
module.exports = { objective, waiting, held, hold };
