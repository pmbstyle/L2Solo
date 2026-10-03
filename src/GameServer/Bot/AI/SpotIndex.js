// One lookup table per spot list: spot id -> spot. Every lookup of a spot by
// its id in a spot list (the world's spots, the profile catalogue, a worker's
// planning list) reads this table instead of scanning the list or keeping a
// table of its own.
const tables = new WeakMap();

function tableFor(spots) {
    let built = tables.get(spots);
    // A list filled in place (the cold worker's) gets a new table. The list's
    // length is compared, not the table's size: a repeated id must not make
    // every lookup rebuild the table.
    if (!built || built.length !== spots.length) {
        built = { length: spots.length, table: new Map(spots.map((spot) => [String(spot.id), spot])) };
        tables.set(spots, built);
    }
    return built.table;
}

function spotById(spots, spotId) {
    return Array.isArray(spots) ? tableFor(spots).get(String(spotId)) || null : null;
}

module.exports = { tableFor, spotById };
