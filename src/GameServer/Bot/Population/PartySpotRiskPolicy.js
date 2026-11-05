const Risk = require('./SpotRiskPolicy');

function rosterKey(party) {
    return [...new Set((party?.memberIds || []).map(Number))].sort((a, b) => a - b).join(',');
}
// The party's spot memory as a holder state: its rounds are its step counter
// (stats.stepCount), the clock of its marks. The risk window and the marks
// reset with a roster change; the rounds stay with the party id, because the
// party's competition avoid (stats.coldCompetition) is not reset with them.
function state(party) {
    const memory = party?.stats?.partySpotRisk;
    const same = memory?.partyId === party?.partyId;
    const current = same && memory?.rosterKey === rosterKey(party) ? memory : {};
    return { spotId: party?.spotId, stats: { spotRisk: current.spotRisk, spotBackoffs: current.spotBackoffs,
        stepCount: same ? Math.max(0, Number(memory.rounds) || 0) : 0,
        coldCompetition: party?.stats?.coldCompetition } };
}
function memory(party, stats) {
    return { partyId: party.partyId, rosterKey: rosterKey(party),
        spotRisk: stats.spotRisk || null, spotBackoffs: stats.spotBackoffs || [],
        rounds: stats.stepCount || 0 };
}
function rounds(party) {
    return state(party).stats.stepCount;
}
// One-time migration of a saved party row's wall-clock marks
// (SpotRiskPolicy.marksInSteps) on the party's own rounds.
function marksInSteps(stats, partyId, now) {
    const counter = rounds({ partyId, stats });
    Risk.marksInSteps(stats, now, counter);
    const memory = stats?.partySpotRisk;
    if (Array.isArray(memory?.spotBackoffs)) {
        stats.partySpotRisk = { ...memory, spotBackoffs: Risk.marksInSteps({ spotBackoffs: memory.spotBackoffs }, now, counter).spotBackoffs };
    }
    return stats;
}
function excludedSpotIds(party, timestamp) {
    return Risk.excludedSpotIdsForStates([state(party)], timestamp);
}
function backoff(party, spotId, timestamp) {
    return Risk.backoffForStates([state(party)], spotId, timestamp);
}
function withBackoff(party, value, timestamp) {
    if (!value) return party;
    const next = Risk.withBackoff(state(party), value, timestamp);
    return { ...party, stats: { ...party.stats, partySpotRisk: memory(party, next.stats) } };
}
function record(party, result, timestamp) {
    if (result?.memberResults) result = { ...result, memberResults: result.memberResults.map(entry => ({
        ...entry, result: require('./ClanEquipmentPartyPolicy').recordOutcome(entry.state, entry.result, party?.stats?.objective, timestamp)
    })) };
    if (!party || !result) return result;
    const fights = Number(result.debug?.fights || 0);
    const deaths = Math.max(0, Number(result.partyPatch?.stats?.deaths || 0) - Number(party.stats?.deaths || 0));
    // Every party resolve is one party step: the rounds move before the
    // early return of a resolve without fights or deaths.
    const previous = state(party).stats, stepCount = previous.stepCount + 1;
    const spotRisk = !fights && !deaths ? previous.spotRisk : Risk.recordResolve(previous.spotRisk || {}, {
        spotId: result.debug?.spotId || party.spotId, timestamp,
        fights, wins: Number(result.debug?.wins || 0), deaths
    });
    return { ...result, partyPatch: { ...result.partyPatch, stats: { ...result.partyPatch?.stats,
        partySpotRisk: memory(party, { ...previous, spotRisk, stepCount }) } } };
}
module.exports = { rosterKey, rounds, marksInSteps, excludedSpotIds, backoff, withBackoff, record };
