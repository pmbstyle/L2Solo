'use strict';
const finite = point => point && ['locX', 'locY', 'locZ'].every(key => point[key] != null && Number.isFinite(Number(point[key])));
const same = (a, b) => finite(a) && finite(b) && ['locX', 'locY', 'locZ'].every(key => Number(a[key]) === Number(b[key]));

// A cached spot id can outlive a visit to town. Keep a real home location
// only inside its spot; otherwise use that spot's known arrival geometry.
// Ground the anchor on the same geometry used to place arriving members.
function point(operation, spot) {
    const Spots = invoke('GameServer/Bot/AI/SpotService');
    if (spot === undefined) spot = Spots.findById(operation.homeSpotId)
        || invoke('GameServer/Bot/Population/SpotProfiles').findById(operation.homeSpotId);
    const candidates = spot ? [operation.homeLoc, spot.center, ...(spot.arrivalPoints || []).slice(0, 8)] : [operation.homeLoc];
    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    for (const loc of candidates) {
        if (!finite(loc) || spot && !Spots.containsLocation(spot, loc)) continue;
        const home = { locX: Number(loc.locX), locY: Number(loc.locY),
            locZ: Geo.getHeight(Number(loc.locX), Number(loc.locY), Number(loc.locZ)) };
        if (finite(home) && (!spot || Spots.containsLocation(spot, home))) return home;
    }
    return null;
}

function reached(loc, home, radius = 900) {
    if (!finite(loc) || !finite(home)
        || Math.hypot(loc.locX - home.locX, loc.locY - home.locY) > radius) return false;
    // A slope can put a member above/below the anchor. Select its ground layer
    // using the home height, never the member's possibly wrong floor.
    const height = invoke('GameServer/Geodata/GeodataEngine').getHeight(loc.locX, loc.locY, home.locZ);
    return Number.isFinite(height) && Math.abs(loc.locZ - height) <= 200;
}
module.exports = { point, same, reached };
