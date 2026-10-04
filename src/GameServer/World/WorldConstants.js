// World distances shared by many systems. Pure values: the cold worker may
// load this module.

// The game client shows players, bots and NPCs within this 2D distance.
const CLIENT_VISIBILITY_RADIUS = 6000;

// Hunting-spot cells: a spot id is its cell `x_y` (plus `:area` inside a
// partitioned dungeon). Spot ids are saved in database rows (a bot's spotId,
// spot backoffs, party records): never change this size without migrating them.
const SPOT_CELL_SIZE = 6000;

// NPC lookup cells. fetchNpcsInRadius searches only the 3x3 cells around a
// point, so a cell must be at least the largest radius it is asked for: the
// visibility radius.
const NPC_GRID_SIZE = CLIENT_VISIBILITY_RADIUS;

module.exports = { CLIENT_VISIBILITY_RADIUS, SPOT_CELL_SIZE, NPC_GRID_SIZE };
