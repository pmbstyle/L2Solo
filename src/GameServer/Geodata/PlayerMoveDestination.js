const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

// Resolve the nearby walking layer without changing the actor's position.
// C4/Lisvus moveCheck resolves target Z after the client's floor-Z conversion.
// Keep this step separate from authoritative movement/position reconciliation.
const MAX_HEIGHT_CORRECTION = 64;
const MAX_DIRECT_DISTANCE = 9900;

function playerMoveDestination(actor, from, to) {
    if (actor.isFlying?.() || actor.stateWater === true || actor.isInWater?.()
        || actor.fetchBoat?.() || actor.fetchBoatId?.() || actor.boat || actor.boatId) return to;
    if (Math.hypot(to.locX - from.locX, to.locY - from.locY) > MAX_DIRECT_DISTANCE) return to;

    const start = GeodataEngine.getCellData(from.locX, from.locY, from.locZ);
    const end = GeodataEngine.getCellData(to.locX, to.locY, to.locZ);
    if (!GeodataEngine.hasGeo(from.locX, from.locY) || !GeodataEngine.hasGeo(to.locX, to.locY)) return to;
    if (Math.abs(start.z - from.locZ) > MAX_HEIGHT_CORRECTION
        || Math.abs(end.z - to.locZ) > MAX_HEIGHT_CORRECTION) return to;
    if (end.z === to.locZ) return to;
    if (!GeodataEngine.canWalkStraight(from.locX, from.locY, from.locZ, to.locX, to.locY, end.z)) return to;

    return { ...to, locZ: end.z };
}

module.exports = playerMoveDestination;
