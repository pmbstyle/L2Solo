const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

function active(state) {
    return Number(state?.stats?.karma || 0) > 0;
}

function targetForSpot(state, spot) {
    // Wash karma on weaker experience-bearing mobs; the normal encounter
    // resolver still permits aggressive neighbours to interrupt the hunt.
    const level = Number(state?.level || 1);
    return Number((spot?.npcEntries || [])
        .filter(entry => Number(entry.selfId) > 0 && Number(entry.level) >= Math.max(1, level - 8)
            && Number(entry.level) <= level)
        .sort((a, b) => Number(a.level) - Number(b.level) || Number(a.selfId) - Number(b.selfId))[0]?.selfId || 0);
}

function plan(state, spots, timestamp = Date.now()) {
    if (!active(state)) return null;
    const clean = { ...state, stats: { ...(state.stats || {}), equipmentPlan: null,
        partyRequest: null, marketReturn: null, craftReturn: null, craftStationId: null,
        warehouseWorkflow: null, warehouseErrand: null, supplyErrand: null } };
    const travel = clean.stats.travel;
    if (state.activity === 'traveling' && travel?.reason === 'karma_washing') {
        return { targetNpcId: 0, plannedState: clean, spot: spots.find(spot => spot.id === travel.spotId) || null };
    }
    const candidates = spots.filter(spot => {
        const point = spot.center;
        return point && !utils.isInPeaceZone(point.locX, point.locY)
            && LevelingRoutes.isSpotAllowedForState(spot, clean, { mode: 'solo' })
            && Number(spot.minLevel || 1) <= Number(state.level || 1)
            && Number(spot.maxLevel || spot.minLevel || 1) >= Math.max(1, Number(state.level || 1) - 8);
    });
    const current = candidates.find(spot => spot.id === state.spotId
        && Math.hypot(Number(spot.center.locX) - Number(state.loc?.locX),
            Number(spot.center.locY) - Number(state.loc?.locY)) < 4500);
    const spot = current || LevelingRoutes.bestSpot(candidates, clean)?.spot || null;
    clean.stats.travel = null;
    if (state.activity === 'dead') return { targetNpcId: 0, plannedState: clean, spot };
    if (current && !utils.isInPeaceZone(state.loc?.locX, state.loc?.locY)) {
        return { targetNpcId: targetForSpot(state, spot), plannedState: { ...clean, spotId: spot.id,
            activity: state.activity === 'resting' ? 'resting' : 'hunting' }, spot };
    }
    if (!spot) return { targetNpcId: 0, plannedState: { ...clean, activity: 'resting' }, spot: null };
    const to = SpotService.arrivalPointForState(clean, spot);
    if (!to || utils.isInPeaceZone(to.locX, to.locY)) {
        return { targetNpcId: 0, plannedState: { ...clean, activity: 'resting' }, spot: null };
    }
    const from = { ...(state.loc || {}) };
    const duration = Math.max(25000, Math.ceil(Math.hypot(to.locX - from.locX, to.locY - from.locY) / 120 * 1000));
    return { targetNpcId: 0, spot, plannedState: { ...clean, activity: 'traveling',
        timing: { ...(state.timing || {}), activityStartedAt: timestamp, nextResolveAt: timestamp + duration },
        stats: { ...clean.stats, travel: { from, to, startedAt: timestamp, arrivalAt: timestamp + duration,
            method: 'walk', reason: 'karma_washing', spotId: spot.id, regionName: spot.name,
            arrivalActivity: 'hunting', arrivalEvent: 'arrived_hunting_ground' } } } };
}

module.exports = { active, plan, targetForSpot };
