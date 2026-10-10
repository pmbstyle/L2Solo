'use strict';
// Shared valuation of additional travel over the existing ColdTrip route.
// Route expansion yields at every edge in the worker; synchronous consumers
// drain the same iterator only at a concrete market decision.
const Trip = require('../Population/ColdTrip');
const Routes = require('../Travel/TravelRoutes');
const Towns = require('../../World/TownRespawn');
const Karma = require('../../Karma');
const Payment = require('../Travel/TripPayment');
const townByName = new Map(Object.values(Towns.towns).map(town => [town.name, town]));
const townKeys = new Map(Object.entries(Towns.towns).map(([key, town]) => [town, key]));
const townOrdinal = new Map([...townByName.keys()].map((name, index) => [name, index]));
const towns = Object.freeze([...townByName.keys()]);
// Shared completed tables only: at most 64 own-route keys and 16 triples each.
// No owner, inventory or native-state reference survives preparation. Money
// is read by each consumer; eviction changes work cost, never route evidence.
const preparedTables = new Map(), MAX_PREPARED_TABLES = 64;
const readers = new WeakMap();
const validPoint = loc => Number.isFinite(Number(loc?.locX)) && Number.isFinite(Number(loc?.locY))
    && (Number(loc.locX) !== 0 || Number(loc.locY) !== 0);
const unknown = () => ({ known: false, hours: NaN, fees: NaN });
function* regionalTown(loc) {
    const x = Number(loc?.locX || 0), y = Number(loc?.locY || 0), z = Number(loc?.locZ);
    const cell = `${(x >> 15) + 20}_${(y >> 15) + 18}`, index = Towns.regionIndex;
    for (const dungeon of index.dungeons) {
        const matches = dungeon.cell === cell && Number.isFinite(z) && z < dungeon.belowZ;
        yield 'edge'; if (matches) return Towns.towns[dungeon.group];
    }
    for (const zone of index.zones) {
        let inside = false;
        for (let at = 0, previous = zone.points.length - 1; at < zone.points.length; previous = at++) {
            const [px, py] = zone.points[at], [qx, qy] = zone.points[previous];
            if ((py > y) !== (qy > y) && x < (qx - px) * (y - py) / (qy - py) + px) inside = !inside;
            yield 'edge';
        }
        if (inside) return Towns.towns[zone.group];
    }
    const regional = Towns.towns[index.cells[cell]];
    if (regional) return regional;
    let closest = null, distance = Infinity;
    for (const town of townByName.values()) {
        const next = (town.locX - x) ** 2 + (town.locY - y) ** 2;
        if (next < distance) { closest = town; distance = next; }
        yield 'edge';
    }
    return closest;
}
// The region is a pure function of the point over the frozen region index, and
// one route table asks it for the same bot point and the same towns 17 times
// each. Remembered by exact coordinates; bounded, so a busy worker only drops
// the oldest points and walks their polygons again. A remembered answer still
// yields one edge: callers read edges as evidence that route geometry was read.
const regions = new Map(), MAX_REGIONS = 1024;
function* region(loc) {
    const id = `${Number(loc?.locX || 0)}|${Number(loc?.locY || 0)}|${Number(loc?.locZ)}`;
    if (regions.has(id)) { yield 'edge'; return regions.get(id); }
    const value = yield* regionalTown(loc);
    if (regions.size >= MAX_REGIONS) regions.delete(regions.keys().next().value);
    regions.set(id, value);
    return value;
}

function* forwardTrip(state, from, to) {
    if (Karma.closesTowns(state.stats?.karma)) return to.name === Karma.TOWN_NAME
        ? { route: { fee: 0, hops: 0 }, durationMs: Trip.honest() ? Trip.runMs(from, to)
            : Math.max(Trip.AUTHOR_TRIP_MS, Trip.runMs(from, to)) } : null;
    const origin = yield* region(from), start = Towns.towns[origin?.respawnTown] || origin;
    const destination = yield* region(to), destinationKey = townKeys.get(destination);
    const gateKey = destinationKey === 'floran_village' ? 'dion_town' : destinationKey;
    const gate = Towns.towns[gateKey], route = Routes.route(townKeys.get(start), gateKey);
    if (!route || !start || !gate) return null;
    const distance = Math.hypot(Number(from.locX) - start.locX, Number(from.locY) - start.locY);
    const inStart = distance <= Trip.TOWN_RADIUS;
    const scroll = !inStart && Payment.hasColdScroll(state);
    const honestMs = (scroll ? Payment.SCROLL_CAST_MS : Trip.runMs(from, start))
        + route.hops * Trip.HOP_MS + Trip.runMs(gate, to);
    yield 'trip';
    return { route, durationMs: Trip.honest() ? honestMs : !inStart && !scroll
        ? Math.max(Trip.AUTHOR_TRIP_MS, Trip.runMs(from, start)) : Trip.AUTHOR_TRIP_MS };
}


function* returnMs(state, from, to) {
    if (!Trip.honest()) return Trip.AUTHOR_TRIP_MS;
    let best = Trip.runMs(from, to);
    if (Karma.closesTowns(state.stats?.karma)) return best;
    const regional = yield* region(from), start = Towns.towns[regional?.respawnTown] || regional;
    if (!start) return NaN;
    const lead = Math.hypot(from.locX - start.locX, from.locY - start.locY) <= Trip.TOWN_RADIUS
        ? Trip.runMs(from, start) : Payment.SCROLL_CAST_MS;
    for (const teleport of Routes.teleportPoints()) {
        const hops = teleport.hops[townKeys.get(start)];
        if (hops !== undefined) best = Math.min(best, lead + hops * Trip.HOP_MS + Trip.runMs(teleport, to));
        yield 'edge';
    }
    return best;
}
function* details(state, town, { origin = null } = {}) {
    const to = townByName.get(town);
    if (!state || !to || Karma.closesTowns(state.stats?.karma) && town !== Karma.TOWN_NAME) return unknown();
    const accepted = state.activity === 'traveling' && state.stats?.travel?.arrivalActivity === 'shopping'
        ? state.stats.travel : null;
    const here = state.activity === 'shopping' ? state.currentRegion : accepted?.townName;
    if (here === town) return { known: true, hours: 0, fees: 0 };
    const continuingVisit = state.activity === 'shopping' || !!accepted;
    const from = accepted?.to || (continuingVisit ? state.loc : origin || state.stats?.marketReturn?.loc || state.loc);
    if (!validPoint(from)) return unknown();
    const returning = continuingVisit ? state.stats?.marketReturn?.loc : from;
    if (returning && !validPoint(returning)) return unknown();
    const plan = yield* forwardTrip(state, from, to);
    if (!plan) return unknown();
    const back = returning ? yield* returnMs(state, to, returning) : 0;
    const baseline = continuingVisit && returning ? yield* returnMs(state, from, returning) : 0;
    const hours = Math.max(0, plan.durationMs + back - baseline) / 3600000;
    const fees = Number(plan.route.fee || 0);
    return Number.isFinite(hours) && Number.isFinite(fees) && fees >= 0 ? { known: true, hours, fees } : unknown();
}
function read(state, town, options) {
    const iterator = details(state, town, options);
    let step; do { step = iterator.next(); } while (!step.done);
    return step.value;
}
const point = loc => loc ? { locX: Number(loc.locX || 0), locY: Number(loc.locY || 0), locZ: Number(loc.locZ || 0) } : null;
// Only own route inputs cross the existing worker boundary. The caller holds
// the decision's location anchor; no inventory or market graph is copied.
function frame(state) {
    const travel = state?.stats?.travel;
    return { activity: String(state?.activity || ''), currentRegion: state?.currentRegion == null ? null : String(state.currentRegion),
        loc: point(state?.loc), inventory: { 736: { amount: Math.max(0, Number(state?.inventory?.[736]?.amount || 0)) } },
        stats: { karma: Math.max(0, Number(state?.stats?.karma || 0)),
            marketReturn: state?.stats?.marketReturn?.loc ? { loc: point(state.stats.marketReturn.loc) } : null,
            travel: travel ? { townName: travel.townName == null ? null : String(travel.townName),
                arrivalActivity: travel.arrivalActivity == null ? null : String(travel.arrivalActivity), to: point(travel.to) } : null } };
}
function key(state) { return JSON.stringify([Trip.honest(), frame(state)]); }
function* prepare(state) {
    const captured = frame(state), routeKey = key(captured), previous = preparedTables.get(routeKey);
    if (previous) {
        preparedTables.delete(routeKey); preparedTables.set(routeKey, previous);
        return previous;
    }
    const rows = [];
    for (const town of towns) {
        const value = yield* details(captured, town);
        rows.push(Object.freeze(value.known ? [true, value.hours, value.fees] : [false, null, null]));
        yield 'trip';
    }
    Object.freeze(rows);
    preparedTables.set(routeKey, rows);
    if (preparedTables.size > MAX_PREPARED_TABLES) preparedTables.delete(preparedTables.keys().next().value);
    return rows;
}
function preparedReader(rows, { hourAdena } = {}) {
    const row = town => {
        const index = townOrdinal.get(town), value = index === undefined ? null : rows?.[index];
        return value?.[0] === true && Number.isFinite(value[1]) && value[1] >= 0
            && Number.isFinite(value[2]) && value[2] >= 0
            ? { known: true, hours: value[1], fees: value[2] } : unknown();
    };
    const cost = town => {
        const value = row(town);
        return value.known && Number.isFinite(hourAdena) && hourAdena >= 0
            ? Math.round(value.hours * hourAdena) + value.fees : Infinity;
    };
    cost.details = row;
    return cost;
}
function reader(state, { hourAdena, origin = null } = {}) {
    const pointKey = loc => [loc?.locX, loc?.locY, loc?.locZ];
    const key = JSON.stringify([hourAdena, Trip.honest(), state?.activity, state?.currentRegion,
        state?.stats?.karma, state?.inventory?.[736]?.amount, pointKey(state?.loc), pointKey(origin),
        pointKey(state?.stats?.marketReturn?.loc), state?.stats?.travel?.townName,
        state?.stats?.travel?.arrivalActivity, pointKey(state?.stats?.travel?.to)]);
    if (state && readers.get(state)?.key === key) return readers.get(state).cost;
    // Fixed town table: 16/17 triples, not one object/Map entry per town/bot.
    // The weak owner key releases this bounded result with its lifecycle row.
    const rows = new Float64Array(townOrdinal.size * 3), ready = new Uint8Array(townOrdinal.size);
    const row = town => {
        const index = townOrdinal.get(town);
        if (index === undefined) return unknown();
        const at = index * 3;
        if (!ready[index]) {
            const value = read(state, town, { origin });
            rows[at] = value.known ? 1 : 0; rows[at + 1] = value.hours; rows[at + 2] = value.fees;
            ready[index] = 1;
        }
        return { known: rows[at] === 1, hours: rows[at + 1], fees: rows[at + 2] };
    };
    const cost = town => {
        const value = row(town);
        return value.known && Number.isFinite(hourAdena) && hourAdena >= 0
            ? Math.round(value.hours * hourAdena) + value.fees : Infinity;
    };
    cost.details = row;
    if (state && typeof state === 'object') readers.set(state, { key, cost });
    return cost;
}
module.exports = { details, read, reader, regionalTown, towns, frame, key, prepare, preparedReader };
