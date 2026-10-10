const AssemblyRecovery = require('./PartyAssemblyRecovery');
// A clan hunt is a shared assignment, never permission to attempt it alone.
function objective(state) {
    if (AssemblyRecovery.coolingDown(state)) return null;
    const value = state?.stats?.clanPartyObjective;
    return value?.status === 'open' && value.clanGoalKey && value.priority === 'required' ? value : null;
}
function waiting(state) {
    return !state?.party?.partyId && !state?.partyId && !!objective(state);
}
function hold(state, timestamp) {
    return { patch: { activity: 'party_wait', stats: { ...state.stats, partyRequest: objective(state),
        lastReason: 'clan_party_assembly' } }, events: [],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 30000,
        debug: { activity: 'clan_party_assembly', fights: 0, wins: 0 } };
}
module.exports = { objective, waiting, hold };
