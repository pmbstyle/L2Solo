const SurvivalFloor = require('./SurvivalFloor');
const cleanupNeed = (member, now) => {
    const floor = SurvivalFloor.forState(member, now);
    return floor?.action === 'unload'
        ? { ...floor, reason: floor.reason === 'no_slot' ? 'inventory_capacity' : 'inventory_overweight' }
        : invoke('GameServer/Bot/Economy/ItemDisposition').inventoryCleanupNeed(member, { now });
};
const cleanupGoal = (need) => invoke('GameServer/Bot/Goals/NeedsEvaluator').cleanupGoal(need);

const RESERVATION_MS = 15 * 60 * 1000;
function clanDuty(party) {
    const objective = party?.stats?.objective;
    return objective?.priority === 'required' && !!objective.clanGoalKey;
}
function pending(party, now = Date.now()) {
    return Object.values(party?.stats?.marketAbsences || {}).filter(value => Number(value.until) > now);
}
// The bag need a clan-duty break reads; null outside a clan duty. A caller
// that already has it passes it on (`need`) so the bag is walked once.
function memberNeed(party, member, now = Date.now()) {
    return clanDuty(party) ? cleanupNeed(member, now) : null;
}
function allowed(party, member, now = Date.now(), need = undefined) {
    if (!clanDuty(party)) return true;
    if (pending(party, now).length) return false;
    return ['inventory_capacity', 'inventory_overweight'].includes((need === undefined ? cleanupNeed(member, now) : need)?.reason);
}
// A clan duty is left only for a bag over its slot limit.
function goal(party, member, current, now, need = undefined) {
    if (!clanDuty(party)) return current;
    const bag = need === undefined ? cleanupNeed(member, now) : need;
    if (!['inventory_capacity', 'inventory_overweight'].includes(bag?.reason)) return null;
    return { ...cleanupGoal(bag), status: 'active' };
}
function departure(party, member, travel, now, given = undefined) {
    if (!clanDuty(party)) return travel;
    const need = given === undefined ? cleanupNeed(member, now) : given;
    const token = { partyId: party.partyId, characterId: member.characterId, until: now + RESERVATION_MS,
        objective: { ...party.stats.objective }, startedAt: now, cleanupReason: need?.reason,
        slots: need?.slots, limit: need?.limit };
    return { ...travel, stats: { ...travel.stats, partyMarketReturn: token,
        lastPartyMarketBreak: token, clanPartyObjective: token.objective } };
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
module.exports = { clanDuty, pending, memberNeed, allowed, goal, departure, stats, ready };
