const Services = require('./Services');
const Karma = require('../Karma');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');

function plan(state, hall, timestamp = Date.now(), options = {}) {
    if (!hall || !state?.loc || Number(state.vitals?.hp) <= 0 || Karma.closesTowns(state.stats?.karma))
        return null;
    const point = {
        fetchLocX: () => state.loc.locX,
        fetchLocY: () => state.loc.locY,
        fetchLocZ: () => state.loc.locZ
    };
    if (!require('./Runtime').Policy.inside(hall, point) && !Services.near(point, Services.manager(hall)))
        return null;
    const spotRetryAfter = { ...options.spotRetryAfter };
    for (const id of SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp)) spotRetryAfter[id] = Infinity;
    const selected = SpotService.findBestSpot({ ...state, spot: null }, {
        mode: 'solo',
        minDistance: 1,
        maxDistance: Infinity,
        equipment: options.equipment || Object.values(state.inventory || {}),
        spotRetryAfter
    });
    if (!selected?.spot) return null;
    const destination = SpotService.arrivalPointForState(state, selected.spot);
    if (!destination || !['locX', 'locY', 'locZ'].every(key => Number.isFinite(destination[key]))
        || !SpotService.containsLocation(selected.spot, destination)) return null;
    return { spot: selected.spot, destination };
}

function hot(session, actor, hall, timestamp = Date.now()) {
    const state = {
        ...session.coldLifeState,
        characterId: actor.fetchId(),
        name: actor.fetchName?.(),
        level: actor.fetchLevel(),
        classId: actor.fetchClassId(),
        loc: Services.point(actor),
        vitals: { hp: actor.fetchHp() },
        stats: { ...session.coldLifeState?.stats, classId: actor.fetchClassId(), karma: actor.fetchKarma?.() || 0 }
    };
    const departure = plan(state, hall, timestamp, {
        equipment: actor.backpack?.fetchItems?.() || [],
        spotRetryAfter: session.spotRetryAfter
    });
    return !!departure && invoke('GameServer/Bot/AI/BotSpotTravel').startFromClanHall(
        session, actor, departure.spot, departure.destination
    );
}

module.exports = { plan, hot };
