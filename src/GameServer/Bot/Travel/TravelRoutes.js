// The gatekeeper network as a fixed table, built once from the C4 teleport
// lists (World/C4GatekeeperTeleports): which town each city gatekeeper stands
// in, the cheapest fee and the number of hops between any two towns, and the
// hops from every town to every teleport point. A trip reads it by key, O(1)
// per town pair; a spot trip scans the ~150 teleport points once per trip.
// Static data only: safe in the cold worker (plain require, no live world).
const GatekeeperTeleports = require('../../World/C4GatekeeperTeleports');
const TownRespawn = require('../../World/TownRespawn');

// City gatekeeper NPC -> TownRespawn town key (spawn positions checked by
// test_travel_routes). Floran has no gatekeeper, as in C4.
const GATEKEEPER_TOWNS = Object.freeze({
    7006: 'ti_village',
    7059: 'dion_town',
    7080: 'giran_town',
    7134: 'de_village',
    7146: 'elven_village',
    7177: 'oren_town',
    7233: 'hunters_village',
    7256: 'gludio_town',
    7320: 'gludin_village',
    7540: 'dwarven_village',
    7576: 'orc_village',
    7848: 'aden_town',
    7899: 'innadril_town',
    8275: 'goddard_town',
    8320: 'rune_town'
});
// Towns no gatekeeper reaches, and the town they are walked to from (C4).
const WALKED_FROM = Object.freeze({ floran_village: 'dion_town' });
// A teleport destination this close to a town centre lands in that town.
const TOWN_LANDING_RADIUS = 3000;

let table = null;
const path = (fee, hops, steps) => Object.defineProperty({ fee, hops }, 'steps', { value: steps });

function townKeyAt(loc) {
    const town = TownRespawn.getClosestTown(loc.locX, loc.locY, loc.locZ);
    const key = Object.keys(TownRespawn.towns).find((candidate) => TownRespawn.towns[candidate] === town);
    if (!key) return null;
    return Math.hypot(town.locX - loc.locX, town.locY - loc.locY) <= TOWN_LANDING_RADIUS ? key : null;
}

// Floyd-Warshall over the ~16 towns, cheapest fee first, then fewest hops.
function build() {
    const towns = Object.keys(TownRespawn.towns);
    const routes = {};
    for (const from of towns) {
        routes[from] = {};
        for (const to of towns) routes[from][to] = from === to ? path(0, 0, []) : null;
    }
    const points = new Map();
    for (const [npcId, rows] of Object.entries(GatekeeperTeleports.lists)) {
        const from = GATEKEEPER_TOWNS[npcId];
        if (!from) continue;
        for (const [destinationId] of rows) {
            const destination = GatekeeperTeleports.destination(Number(npcId), destinationId);
            if (!destination) continue;
            const to = townKeyAt(destination);
            if (to && to !== from) {
                const current = routes[from][to];
                if (!current || destination.price < current.fee) routes[from][to] = path(destination.price, 1, [{ locX: destination.locX, locY: destination.locY, locZ: destination.locZ, fee: destination.price, npcId: Number(npcId), destinationId }]);
            }
            const key = `${destination.locX}:${destination.locY}:${destination.locZ}`;
            if (!points.has(key)) points.set(key, { locX: destination.locX, locY: destination.locY, locZ: destination.locZ, towns: new Set() });
            points.get(key).towns.add(from);
        }
    }
    for (const middle of towns) {
        for (const from of towns) {
            const first = routes[from][middle];
            if (!first) continue;
            for (const to of towns) {
                const second = routes[middle][to];
                if (!second) continue;
                const fee = first.fee + second.fee;
                const hops = first.hops + second.hops;
                const current = routes[from][to];
                if (!current || fee < current.fee || (fee === current.fee && hops < current.hops)) {
                    routes[from][to] = path(fee, hops, [...first.steps, ...second.steps]);
                }
            }
        }
    }
    // Hops from each town to each teleport point: the route to a town whose
    // gatekeeper lists the point, plus that last hop. Towns are points too.
    const teleportPoints = [...points.values()].map((point) => {
        const hops = {};
        for (const from of towns) {
            let best = Infinity;
            for (const via of point.towns) {
                const route = routes[from][via];
                if (route) best = Math.min(best, route.hops + 1);
            }
            if (best < Infinity) hops[from] = best;
        }
        return Object.freeze({ locX: point.locX, locY: point.locY, locZ: point.locZ, hops: Object.freeze(hops) });
    });
    for (const key of towns) {
        const town = TownRespawn.towns[key];
        const hops = {};
        for (const from of towns) if (routes[from][key]) hops[from] = routes[from][key].hops;
        teleportPoints.push(Object.freeze({ locX: town.locX, locY: town.locY, locZ: town.locZ, hops: Object.freeze(hops) }));
    }
    return { routes, teleportPoints: Object.freeze(teleportPoints) };
}

function ensure() {
    table ||= build();
    return table;
}

// The cheapest gatekeeper route between two towns (TownRespawn keys):
// { fee, hops }, path(0, 0, []) for the same town, null without one.
function route(fromKey, toKey) {
    return ensure().routes[fromKey]?.[toKey] || null;
}

function teleportPoints() {
    return ensure().teleportPoints;
}

// The TownRespawn key of a town object or of the town by the region rule at a point.
function townKey(town) {
    if (!town) return null;
    return Object.keys(TownRespawn.towns).find((key) => TownRespawn.towns[key] === town) || null;
}

// Where a Scroll of Escape read at `loc` lands: the region's restart town
// (Floran's cell restarts at Dion), as TownRespawn.getRespawnCoords.
function landingTown(loc) {
    const closest = TownRespawn.getClosestTown(Number(loc?.locX || 0), Number(loc?.locY || 0), Number(loc?.locZ || 0));
    return TownRespawn.towns[closest.respawnTown] || closest;
}

// A trip from `from` into the town at `to`: the town it starts from (where a
// Scroll of Escape lands), the destination's town by the region rule, the
// town whose gatekeeper it arrives at (Floran: Dion, then on foot) and the
// gatekeeper route from the start to that gate (null without one).
function between(from, to) {
    const start = landingTown(from);
    const destination = TownRespawn.getClosestTown(Number(to?.locX || 0), Number(to?.locY || 0), Number(to?.locZ || 0));
    const gateKey = WALKED_FROM[townKey(destination)] || townKey(destination);
    return { start, destination, gate: TownRespawn.towns[gateKey], route: route(townKey(start), gateKey) };
}

module.exports = { GATEKEEPER_TOWNS, route, teleportPoints, townKey, landingTown, between };
