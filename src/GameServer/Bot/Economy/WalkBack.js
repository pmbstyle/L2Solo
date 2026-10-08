const DiagnosticConfig = require('../Population/PopulationConfig');
'use strict';
const Trip = require('../Population/ColdTrip');
const Routes = require('../Travel/TravelRoutes');
let source, entries = new Map(), catalogs = new WeakMap(), builds = 0, missing = 0, buildMs = 0;
function table(spots) {
    if (source === spots) return entries;
    // ARCH-NOTE: ALT native profile/raw catalogs coexist. A single last
    // source evicts the other on every alternating reader. Weak keys retain
    // each table only for its catalog lifetime, with no per-bot cache.
    // ARCH-NOTE: PERF 80 alternating native reads: 80 -> 2 builds, 546 -> 15 ms;
    // +155192 fixed bytes. Warm 80 reads: 549 -> 0.28 ms, no replans.
    const cached = catalogs.get(spots);
    if (cached) { source = spots; entries = cached; return entries; }
    const started = DiagnosticConfig.developerDiagnostics ? performance.now() : 0, next = new Map();
    for (const spot of spots || []) {
        if (!spot?.id || !spot.center) continue;
        const from = Routes.landingTown(spot.center);
        // ARCH-NOTE: retain two catalogue-owned coordinate references beside
        // the number so a karma walk also has O(1) lookup, without a second index.
        next.set(String(spot.id), { ms: Trip.spotPlan({ loc: from, stats: {} }, spot.center).durationMs,
            from, to: spot.center });
    }
    if (spots && (typeof spots === 'object' || typeof spots === 'function')) catalogs.set(spots, next);
    source = spots; entries = next;
    if (DiagnosticConfig.developerDiagnostics) { builds++; buildMs = performance.now() - started; }
    if (DiagnosticConfig.developerDiagnostics) utils.infoSuccess('WalkBack', 'cached %d return routes in %d ms', entries.size, Math.round(buildMs));
    return entries;
}
function hours(spotId, state = {}, spots = invoke('GameServer/Bot/AI/SpotService').spots) {
    if (!spotId) return 0;
    const entry = table(spots).get(String(spotId));
    if (!entry) { if (DiagnosticConfig.developerDiagnostics) missing++; return 0; }
    if (require('../../Karma').closesTowns(state.stats?.karma)) return Trip.runMs(entry.from, entry.to) / 3600000;
    // ARCH-NOTE: the default world uses the authored 25-second trip; price
    // the actual downtime rather than charging a walk it does not perform.
    return (Trip.honest() ? entry.ms : Trip.AUTHOR_TRIP_MS) / 3600000;
}
module.exports = { hours, reset: () => { source = undefined; entries = new Map(); catalogs = new WeakMap(); builds = missing = buildMs = 0; },
    summary: () => DiagnosticConfig.developerDiagnostics ? ({ size: entries.size, builds, missing, buildMs }) : { enabled: false } };
