const Services = require('./Services');
const Karma = require('../Karma');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

// The hall's departure teleports the bot to the spot its held decisions name (main
// never chooses one): spotId, a hot body's (DecisionEvents.heldSpotId), else a far
// bot's (DecisionEvents.farHeldSpot: its row and its held card's leaf). None
// (none held, or all its exclusions rule out: died, was full, unreachable): no
// teleport, it leaves the hall as it came.
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
    const spotId = options.spotId !== undefined ? options.spotId : invoke('GameServer/Bot/AI/DecisionEvents').farHeldSpot(state);
    if (spotId == null) return null;
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
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const departure = plan(state, hall, { spotId: Events.heldSpotId(session, Events.held(session)?.network.activity) });
    return !!departure && invoke('GameServer/Bot/AI/BotSpotTravel').startFromClanHall(
        session, actor, departure.spot, departure.destination
    );
}

module.exports = { plan, hot };
