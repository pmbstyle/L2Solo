// Hot side only (the cold worker must not load World): the bodies standing near an NPC, as plain data for
// TownNpcApproach's place pick.
const ActorSpatialQueries = invoke('GameServer/World/ActorSpatialQueries');
const { MAX_INTERACTION_DISTANCE } = invoke('GameServer/Bot/AI/TownNpcApproach');

// bodiesNear(target) for this bot: every other actor within reach of the NPC as {locX, locY, actorId}.
function seenBy(bot) {
    return (target) => ActorSpatialQueries.near(invoke('GameServer/World/World'), target, MAX_INTERACTION_DISTANCE)
        .filter(session => session.actor && session.actor !== bot)
        .map(({ actor }) => ({
            locX: Number(actor.fetchLocX?.() ?? actor.locX ?? 0),
            locY: Number(actor.fetchLocY?.() ?? actor.locY ?? 0),
            actorId: Number(actor.fetchId?.() ?? actor.actorId ?? 0)
        }));
}

module.exports = { seenBy };
