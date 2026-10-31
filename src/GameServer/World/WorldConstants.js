// World distances shared by many systems. Pure values and one pure predicate:
// the cold worker may load this module.

// The game client shows players, bots and NPCs within this 2D distance.
const CLIENT_VISIBILITY_RADIUS = 6000;
const CLIENT_VISIBILITY_RADIUS_SQUARED = CLIENT_VISIBILITY_RADIUS * CLIENT_VISIBILITY_RADIUS;

// Does a client at one point see the other? The one rule of the view: packets
// to a viewer, the hit of a started attack, and every other yes-or-no on it.
// A place that keeps a measured distance for several bands compares the radius.
function inClientView(fromX, fromY, toX, toY) {
    const dx = toX - fromX, dy = toY - fromY;
    return dx * dx + dy * dy < CLIENT_VISIBILITY_RADIUS_SQUARED;
}

// Hunting-spot cells: a spot id is its cell `x_y` (plus `:area` inside a
// partitioned dungeon). Spot ids are saved in database rows (a bot's spotId,
// spot backoffs, party records): never change this size without migrating them.
const SPOT_CELL_SIZE = 6000;

// NPC lookup cells. fetchNpcsInRadius searches only the 3x3 cells around a
// point, so a cell must be at least the largest radius it is asked for: the
// visibility radius.
const NPC_GRID_SIZE = CLIENT_VISIBILITY_RADIUS;

module.exports = { CLIENT_VISIBILITY_RADIUS, SPOT_CELL_SIZE, NPC_GRID_SIZE, inClientView };
