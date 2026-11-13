'use strict';

// The walking way between a hunting spot and its town: per spot, the points of
// the shortest geodata walk from its centre to the town a body there walks to
// (TownRespawn.getClosestTown), each leg found by a 2000-node search in its
// walking direction (scripts/generate-town-ways.js builds data/Bots/town-ways.json).
// A straight line from such a spot may cross a ridge or a canyon no walk
// crosses; a C4 player without a scroll runs the way round it. Spurs join the
// way where a body starts or ends off it: per town, from each service NPC to the
// town end of its ways and back (the walk in ends at the NPC, the walk back
// starts there), and per spot, from a spawn point to its centre where that
// point's first leg onto the way fails the same search. Read by TownPathfinder
// (hot, main). Plain data, no World: safe on the worker.
const fs = require('fs');
const path = require('path');
const FailureLog = require('../../../FailureLog');
const TownRespawn = require('../../World/TownRespawn');

const DEFAULT_FILE = path.resolve(__dirname, '../../../../data/Bots/town-ways.json');
// A way point is reached within this distance (TownPathfinder keeps a leg until
// the body is this close to it).
const ARRIVAL = 250;
// A body anywhere on its 6000 u spot cell joins its way from this far.
const JOIN = 4500;
// A way point is on the body's floor within this height.
const FLOOR = 256;
// A body talking to an NPC stands within this distance of it (the interaction
// cap, TownNpcApproach): it takes the spur that starts at that NPC.
const SPUR_ENTRY = 300;

let file = DEFAULT_FILE;
let table;
// Decoded ways by spot id, and town spurs by town key, within the one loaded
// file (its only input; useFile/reset clear them).
const ways = new Map();
const townSpurs = new Map();

function load() {
    if (table !== undefined) return table;
    try {
        table = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        // A server without its ways walks every far walk by the straight leg: counted.
        FailureLog.note('TownWays.load', error);
        table = null;
    }
    return table;
}

function decode(flat) {
    const points = [];
    for (let i = 0; i + 2 < flat.length; i += 3) points.push(Object.freeze({ locX: flat[i], locY: flat[i + 1], locZ: flat[i + 2] }));
    return Object.freeze(points);
}

function spursOf(rows) {
    return Object.freeze((rows || []).map((spur) => decode(spur.points)));
}

// A town's NPC spurs: from where a body talks to the NPC to the town end (the
// walk back), and from the town end there (the walk in: the reverse unless the
// build stored its own; null where none walks that way); npcs: each NPC's point.
function spursOfTown(townKey) {
    if (!townSpurs.has(townKey)) {
        const rows = load()?.towns?.[townKey]?.spurs || [];
        const back = spursOf(rows);
        const into = Object.freeze(rows.map((row, i) => (!row.toNpc ? Object.freeze(back[i].slice().reverse())
            : row.toNpc.length ? decode(row.toNpc) : null)));
        const npcs = Object.freeze(rows.map((row, i) => (row.at ? decode(row.at)[0] : back[i][0])));
        townSpurs.set(townKey, { back, into, npcs });
    }
    return townSpurs.get(townKey);
}

// The spot's way: { spotId, townKey, townName, start, out, back, spurs, townSpurs,
// npcs, into }, null for a spot without one; into: per town NPC, the way out on to it.
function way(spotId) {
    const id = String(spotId);
    if (ways.has(id)) return ways.get(id);
    const row = load()?.ways?.[id] || null;
    let decoded = null;
    if (row && Array.isArray(row.out) && row.out.length >= 6 && TownRespawn.towns[row.town]) {
        const out = decode(row.out);
        const town = spursOfTown(row.town);
        decoded = Object.freeze({
            spotId: id,
            townKey: row.town,
            townName: TownRespawn.towns[row.town].name,
            start: out[0],
            out,
            back: row.back ? decode(row.back) : Object.freeze(out.slice().reverse()),
            spurs: spursOf(row.spurs),
            townSpurs: town.back,
            npcs: town.npcs,
            into: Object.freeze(town.into.map((spur) => (spur ? Object.freeze([...out, ...spur.slice(1)]) : null)))
        });
    }
    ways.set(id, decoded);
    return decoded;
}

function flat(a, b) {
    return Math.hypot(a.locX - b.locX, a.locY - b.locY);
}

function onFloor(point, from) {
    return Math.abs(point.locZ - from.locZ) <= FLOOR;
}

// Is this target the spot's centre (the walk back's end)?
function atStart(way, to) {
    return !!way && !!to && flat(to, way.start) <= ARRIVAL && onFloor(way.start, to);
}

// The way out for a target: on to the NPC it stands at (within SPUR_ENTRY of a
// town spur's NPC, on its floor), else the way to the town end.
function wayInto(way, to) {
    if (to) {
        for (let i = 0; i < way.townSpurs.length; i++) {
            const npc = way.npcs[i];
            if (way.into[i] && flat(npc, to) <= SPUR_ENTRY && onFloor(npc, to)) return way.into[i];
        }
    }
    return way.out;
}

// Does the way out still lead the body nearer this target in its town: is the
// way's town end nearer it than the body? Past that the town's own routing takes
// the body on, and the way does not pull it back.
function leadsCloser(way, to, from) {
    return flat(from, to) > flat(way.out[way.out.length - 1], to);
}

// The highest point on the body's floor it stands within reach of (the first
// point within firstReach), -1 for none.
function reachedOn(points, from, firstReach = ARRIVAL) {
    for (let i = points.length - 1; i >= 0; i--) {
        if (onFloor(points[i], from) && flat(points[i], from) <= (i === 0 ? firstReach : ARRIVAL)) return i;
    }
    return -1;
}

// The point a body heads for on a way: the one after the farthest point it
// reached (null past the end), else the nearest point on its floor within
// JOIN (null: none). A way passing near itself never sends the body back.
function next(points, from) {
    const reached = reachedOn(points, from);
    if (reached >= 0) return points[reached + 1] || null;
    let nearest = null, best = JOIN;
    for (const point of points) {
        const d = flat(point, from);
        if (d <= best && onFloor(point, from)) { best = d; nearest = point; }
    }
    return nearest;
}

// The point a body heads for on its way, out to the town (outward: on to the
// target's NPC) or back to the spot: on the way when it reached a point of it;
// else on a spur it reached (the spot's spawn spurs out, the one it is still at the
// start of first: a spawn spur is stored for that point, so an earlier spur passing
// near never hides it; back, the town's NPC spurs, taken at their NPC only while
// the body stands in that town), then the way from the spur's end; else the way's
// join. A walk back with no way back gives none: the spot walks as without a way.
function wayPoint(way, from, outward, inTown = false, to = null) {
    if (!way) return null;
    const points = outward ? wayInto(way, to) : way.back;
    if (!points.length) return null;
    if (reachedOn(points, from) >= 0) return next(points, from);
    const entry = outward || inTown ? SPUR_ENTRY : -1;
    const spurs = outward ? way.spurs : way.townSpurs;
    if (outward) {
        for (const spur of spurs) {
            if (reachedOn(spur, from, entry) === 0) return spur[1] || next(points, from);
        }
    }
    for (const spur of spurs) {
        const reached = reachedOn(spur, from, entry);
        if (reached >= 0) return spur[reached + 1] || next(points, from);
    }
    return next(points, from);
}

function useFile(next = DEFAULT_FILE) {
    file = next;
    reset();
}

function reset() {
    table = undefined;
    ways.clear();
    townSpurs.clear();
}

module.exports = { way, atStart, wayInto, leadsCloser, reachedOn, next, wayPoint, useFile, reset, ARRIVAL, JOIN, FLOOR, SPUR_ENTRY, DEFAULT_FILE };
