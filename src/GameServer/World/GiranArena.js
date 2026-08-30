// C4 source-backed geometry for the small arena beside Giran.
//
// Lisvus/L2J defines the playable ArenaZone as a cuboid (zone 11010):
//   X 72496..73472, Y 142272..143248, Z -3800..-3600.
// The entrance is a separate peace-zone polygon, so it must not be treated
// as playable ground by the duel controller.
const BOUNDS = Object.freeze({
    minX: 72496,
    maxX: 73472,
    minY: 142272,
    maxY: 143248,
    minZ: -3800,
    maxZ: -3600
});

const RESTART = Object.freeze({ locX: 73890, locY: 142656, locZ: -3778 });
const NPC = Object.freeze({ locX: 73579, locY: 142709, locZ: -3768 });

function coordinate(value) {
    return Number(value);
}

function isInside(locX, locY, locZ) {
    const x = coordinate(locX);
    const y = coordinate(locY);
    const z = coordinate(locZ);
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
        && x >= BOUNDS.minX && x <= BOUNDS.maxX
        && y >= BOUNDS.minY && y <= BOUNDS.maxY
        && z >= BOUNDS.minZ && z <= BOUNDS.maxZ;
}

function isInsideActor(actor) {
    return isInside(actor?.fetchLocX?.(), actor?.fetchLocY?.(), actor?.fetchLocZ?.());
}

function distanceSquared(first, second) {
    const dx = coordinate(first?.locX) - coordinate(second?.locX);
    const dy = coordinate(first?.locY) - coordinate(second?.locY);
    const dz = coordinate(first?.locZ) - coordinate(second?.locZ);
    return (dx * dx) + (dy * dy) + (dz * dz);
}

module.exports = {
    BOUNDS,
    RESTART,
    NPC,
    isInside,
    isInsideActor,
    distanceSquared
};
