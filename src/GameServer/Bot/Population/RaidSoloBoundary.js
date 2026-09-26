// Raid combat belongs to the shared party encounter, never to solo fallback
// combat. Keep this boundary independent of the live world and worker ownership.
let cachedNpcs;
let raidIds = new Set();
function raidTarget(id) {
    if (!(Number(id) > 0)) return false;
    const npcs = invoke('GameServer/DataCache').npcs;
    if (npcs !== cachedNpcs) {
        cachedNpcs = npcs;
        raidIds = new Set((npcs || []).filter(npc => npc.template?.raidBoss === true).map(npc => Number(npc.selfId)));
    }
    return raidIds.has(Number(id));
}
function raidSpot(spot) {
    return spot?.raidBoss === true || spot?.route === 'raid_boss'
        || String(spot?.id || '').startsWith('raid:');
}
function raidObjective(objective) {
    return objective?.sourceKind === 'raid' || objective?.raidBoss === true;
}
function stale(state, objective = null) {
    return raidSpot({ id: state?.spotId }) || raidObjective(objective)
        || raidObjective(state?.stats?.clanPartyObjective);
}
function blocked(state, spot, targetNpcId) {
    return stale(state) || raidSpot(spot) || raidTarget(targetNpcId)
        || raidTarget(state?.stats?.pveEncounter?.mob?.selfId);
}
function clear(state) {
    return { ...state,
        ...(raidSpot({ id: state.spotId }) ? { spotId: null } : {}),
        stats: { ...state.stats, pveEncounter: null,
            ...(raidObjective(state.stats?.equipmentPlan?.next) ? { equipmentPlan: null } : {}),
            ...(raidObjective(state.stats?.partyRequest) ? { partyRequest: null } : {}),
            ...(raidObjective(state.stats?.clanPartyObjective) ? { clanPartyObjective: null } : {}) } };
}
module.exports = { raidSpot, stale, blocked, clear };
