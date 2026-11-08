const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');

const { isMainThread } = require('node:worker_threads');
const { partyTradeAllowed } = require('./PartyAdmission');

const ELIGIBLE_ACTIVITIES = new Set(['hunting', 'resting', 'party_wait']);

function spotFor(state, objective = null) {
    return String(PartyRequestPlanner.objectiveSpot(state, objective) || '');
}

// A bot free to be grouped now (a clan raid roster's availability read).
function eligible(state) {
    return Boolean(
        Number(state?.characterId || 0) > 0
        && state.phase === 'cold'
        && ELIGIBLE_ACTIVITIES.has(state.activity)
        && !state.party?.partyId
        && !state.partyId
        && partyTradeAllowed('party', state)
        && (!isMainThread || require('../../AfkTrade/TradeMeetingService').canJoinParty(state.characterId, state))
        && spotFor(state)
    );
}

module.exports = { eligible, spotFor };
