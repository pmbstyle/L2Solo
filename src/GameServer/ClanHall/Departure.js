const Services = require('./Services');
const Karma = require('../Karma');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

// The hall's departure teleports the bot to the spot it goes to when sent to hunt (the
// worker's choice; main never chooses one): spotId, a hot body's
// (DecisionEvents.heldSpotId), else a far bot's (DecisionEvents.heldSpotOf: its row).
// None (none published, its exclusions rule it out: died, was full, unreachable) or
// pending (a raise the worker has not answered may move it: a player's command): no
// teleport, it leaves the hall as it came and the worker routes it.
function plan(state, hall, options = {}) {
    if (!hall || !state?.loc || Number(state.vitals?.hp) <= 0 || Karma.closesTowns(state.stats?.karma))
        return null;
    const point = {
        fetchLocX: () => state.loc.locX,
        fetchLocY: () => state.loc.locY,
        fetchLocZ: () => state.loc.locZ
    };
    if (!require('./Runtime').Policy.inside(hall, point) && !Services.near(point, Services.manager(hall)))
        return null;
    const spotId = options.spotId !== undefined ? options.spotId : invoke('GameServer/Bot/AI/DecisionEvents').heldSpotOf(state);
    if (spotId == null || spotId === 'pending') return null;
    const spot = SpotService.findById(spotId);
    if (!spot) return null;
    const destination = SpotService.arrivalPointForState(state, spot);
    if (!destination || !['locX', 'locY', 'locZ'].every(key => Number.isFinite(destination[key]))
        || !SpotService.containsLocation(spot, destination)) return null;
    return { spot, destination };
}

function hot(session, actor, hall) {
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
    const departure = plan(state, hall, { spotId: invoke('GameServer/Bot/AI/DecisionEvents').heldSpotId(session) });
    return !!departure && invoke('GameServer/Bot/AI/BotSpotTravel').startFromClanHall(
        session, actor, departure.spot, departure.destination
    );
}

module.exports = { plan, hot };
