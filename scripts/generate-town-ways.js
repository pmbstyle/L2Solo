#!/usr/bin/env node
'use strict';

// The town ways (read at run time by GameServer/Bot/Travel/TownWays): per
// hunting spot within MAX_DISTANCE of its town, the shortest geodata walk from
// its centre to that town's point (TownRespawn.getClosestTown, the town a body
// there walks to), densified and cut into legs each found by a LEG_NODES
// search with an exact goal in its walking direction (the smallest search a
// walk issues: the sync move on main). Spurs: from each service NPC of a town
// (TownServiceCatalog) to the town's point and back (the walk in ends at the
// NPC, the walk back starts there); from each spawn point of a spot whose
// first leg onto its way fails that search, a way to the spot's centre.
//
// Usage: node scripts/generate-town-ways.js [--out=data/Bots/town-ways.json]
//        [--spot-ids=id,id]   (only these spots and their towns' spurs: a pick, own --out)
//        [--shard=i/n --out=part.json]   (the i-th of n shares of the spots: a part)
//        [--merge --parts=dir]   (the parts -> the spurs and the table)
//
// Deterministic: the catalogue is the spot generator's (buildCatalogue), every
// search is exact; the output does not depend on the shards. Runs with the
// server's geodata (npm run geodata); refuses without.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const TableFingerprint = require('../src/GameServer/Bot/AI/TableFingerprint');

const root = path.resolve(__dirname, '..');
process.chdir(root);

const SCHEMA_VERSION = 1;
// Spots farther (straight) from their town's point keep the straight leg: the
// search grows with the distance (beyond this many ways need over 1.5M nodes).
const MAX_DISTANCE = 25000;
// The way's search: the longest way found within 25 km took 1.47M nodes.
const MAX_NODES = 1_500_000;
// A spur stays within a town or a spot cell.
const SPUR_NODES = 200_000;
// An NPC stands behind its counter or in a closed cell: its spur ends where a
// body stands within this reach of it (it talks from there).
const SPUR_REACH = 150;
const LEG_MAX = 600;
const LEG_CLIMB = 192;
const LEG_NODES = 2000;
const BISECT_DEPTH = 4;

function args() {
    const out = { out: path.join(root, 'data', 'Bots', 'town-ways.json'), spotIds: null, shard: null, merge: false, parts: null, revision: null };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'out') out.out = path.resolve(value);
        else if (key === 'spot-ids') out.spotIds = value.split(',').filter(Boolean);
        else if (key === 'shard') out.shard = value.split('/').map(Number);
        else if (key === 'merge') out.merge = true;
        else if (key === 'parts') out.parts = path.resolve(value);
        else if (key === 'revision') out.revision = value;
        else throw new Error(`unknown argument ${arg}`);
    }
    if (out.shard && !(out.shard[1] >= 1 && out.shard[0] >= 1 && out.shard[0] <= out.shard[1])) throw new Error('bad --shard');
    if (out.merge && !out.parts) throw new Error('--merge needs --parts');
    if ((out.spotIds || out.shard) && out.out === path.join(root, 'data', 'Bots', 'town-ways.json')) throw new Error('a pick or a part needs its own --out');
    return out;
}

function gitRevision() {
    try {
        return childProcess.execSync('git rev-parse --short=9 HEAD', { cwd: root }).toString().trim();
    } catch (_) {
        return 'unknown';
    }
}

let Geo = null;
const flat = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
const sameCell = (a, b) => a.locX >> 4 === b.locX >> 4 && a.locY >> 4 === b.locY >> 4 && a.locZ === b.locZ;
const onFloor = (p) => ({ locX: p.locX, locY: p.locY, locZ: Geo.getHeight(p.locX, p.locY, p.locZ) });

// The search as a walk issues it, and why it found nothing: 'cap' (the node
// budget ran out) or 'closed' (no cell left to try). The search pauses every
// 128 expanded nodes: the pauses count them.
function search(a, b, maxNodes, goalRadius = 0) {
    const steps = Geo.findPathSteps(a.locX, a.locY, a.locZ, b.locX, b.locY, b.locZ, maxNodes,
        { debug: false, goalRadius, goalZTolerance: 64 });
    let step = steps.next(), pauses = 0;
    while (!step.done) { pauses++; step = steps.next(); }
    const path = step.value;
    if (Array.isArray(path) && path.length) return { path };
    return { path: null, reason: pauses >= Math.floor(maxNodes / 128) ? 'cap' : 'closed' };
}

// Leg verdicts by their two points (the search's only inputs): the town checks
// ask the same spur legs once per way.
const legs = new Map();
function legWalks(a, b) {
    if (sameCell(a, b)) return true;
    const key = `${a.locX},${a.locY},${a.locZ}>${b.locX},${b.locY},${b.locZ}`;
    if (!legs.has(key)) {
        const path = Geo.findPath(a.locX, a.locY, a.locZ, b.locX, b.locY, b.locZ, LEG_NODES, { debug: false });
        legs.set(key, Array.isArray(path) && path.length > 1);
    }
    return legs.get(key);
}

// A point on the straight walk from a toward (x, y): there on the floor the walk
// stands on, else where the walk stopped; a walk that cannot take a step (the
// line's height there picks another floor) gives the floor nearest that height
// at (x, y). The leg search then decides.
function pointToward(a, x, y, z) {
    const end = Geo.straightMoveEnd(a.locX, a.locY, a.locZ, x, y, Math.round(z));
    if (end.reached || !sameCell(end, a)) return { locX: end.locX, locY: end.locY, locZ: end.locZ };
    return { locX: x, locY: y, locZ: Geo.getCellData(x, y, Math.round(z)).z };
}

// Each straight piece of a found walk cut into legs of at most LEG_MAX and LEG_CLIMB.
function densify(path) {
    const points = [{ ...path[0] }];
    for (let i = 1; i < path.length; i++) {
        const a = points[points.length - 1], b = path[i];
        const n = Math.max(1, Math.ceil(flat(a, b) / LEG_MAX), Math.ceil(Math.abs(b.locZ - a.locZ) / LEG_CLIMB));
        for (let k = 1; k < n; k++) {
            const p = pointToward(a, Math.round(a.locX + (b.locX - a.locX) * k / n), Math.round(a.locY + (b.locY - a.locY) * k / n),
                a.locZ + (b.locZ - a.locZ) * k / n);
            if (!sameCell(p, points[points.length - 1])) points.push(p);
        }
        if (!sameCell(b, points[points.length - 1]) || i === path.length - 1) points.push({ locX: b.locX, locY: b.locY, locZ: b.locZ });
    }
    return points;
}

// The legs of a way in its walking direction, each found by a LEG_NODES search;
// a failing leg is halved (BISECT_DEPTH levels). Null when one still fails.
function verified(points) {
    const out = [points[0]];
    const leg = (a, b, depth) => {
        if (legWalks(a, b)) { out.push(b); return true; }
        if (depth >= BISECT_DEPTH) return false;
        const mid = pointToward(a, Math.round((a.locX + b.locX) / 2), Math.round((a.locY + b.locY) / 2), (a.locZ + b.locZ) / 2);
        if (sameCell(mid, a) || sameCell(mid, b)) return false;
        return leg(a, mid, depth + 1) && leg(mid, b, depth + 1);
    };
    for (let i = 1; i < points.length; i++) if (!leg(out[out.length - 1], points[i], 0)) return null;
    // The reader goes on from the farthest point a body stands within reach of
    // (TownWays.next): where the way passes near itself that leg skips ahead; it
    // must pass the same search.
    for (let i = 0; i < out.length - 1; i++) {
        const target = TownWays.next(out, out[i]);
        if (target && target !== out[i + 1] && !legWalks(out[i], target)) return null;
    }
    return out;
}

const pack = (points) => points.flatMap((p) => [p.locX, p.locY, p.locZ]);

// A spawn point's spur to the spot's centre, verified forward (the way a body
// walks it); null when none.
function spur(from, to) {
    const found = search(from, to, SPUR_NODES);
    return (found.path && verified(densify([from, ...found.path.slice(1)]))) || null;
}

function spotTask(profile, counts) {
    const c = profile.center;
    const start = onFloor(c);
    const town = TownRespawn.getClosestTown(start.locX, start.locY, start.locZ);
    const townKey = Object.keys(TownRespawn.towns).find((key) => TownRespawn.towns[key] === town);
    const end = onFloor(town);
    const found = search(start, end, MAX_NODES);
    if (!found.path) return { none: found.reason };
    const out = verified(densify([start, ...found.path.slice(1)]));
    if (!out) return { none: 'leg' };
    const row = { town: townKey, out: pack(out) };
    // Back: the same legs reversed (halved where needed), else a search from the town.
    let back = verified(out.slice().reverse());
    if (!back) {
        const again = search(end, start, MAX_NODES);
        back = again.path && verified(densify([end, ...again.path.slice(1)]));
        if (!back) { counts.oneWay++; back = []; }
    }
    if (back.length !== out.length || back.some((p, i) => !sameCell(p, out[out.length - 1 - i]))) row.back = pack(back);
    // The walk out from where the body hunts: each spawn point's first leg as the
    // reader takes it (onto the way, or a spur stored so far).
    // Counted again over all spurs: a later spur may start near an earlier point.
    const spurs = [];
    const spawns = (profile.arrivalPoints || []).map(onFloor);
    for (const from of spawns) {
        if (joins({ out, spurs }, from, true)) continue;
        counts.spawnJoinFail++;
        const s = spur(from, start);
        if (s) spurs.push(s);
    }
    const kept = settled(out, spurs);
    counts.spawnJoinUnfixed += spawns.filter((from) => !joins({ out, spurs: kept }, from, true)).length;
    if (kept.length) {
        row.spurs = kept.map((s) => ({ points: pack(s) }));
        counts.spawnSpurs += kept.length;
    }
    return { row };
}

// The spur set the reader walks: every point of every spur, taken through
// TownWays.wayPoint with the whole set (a later spur may start near an earlier
// one's points), must lead to a leg that passes the search; a spur with a point
// that does not is dropped (its spawn point is then counted unfixed).
function settled(out, spurs) {
    for (let i = 0; i < spurs.length; i++) {
        const way = { out, spurs };
        if (spurs[i].every((p) => { const target = TownWays.wayPoint(way, p, true); return !target || legWalks(p, target); })) continue;
        spurs = spurs.filter((_, k) => k !== i);
        i = -1;
    }
    return spurs;
}

// Does the first leg the reader takes from here (TownWays.wayPoint) pass the search?
function joins(way, from, outward) {
    const target = TownWays.wayPoint(way, from, outward, true);
    return !!target && legWalks(from, target);
}

const unpack = (flatPoints) => {
    const points = [];
    for (let i = 0; i + 2 < flatPoints.length; i += 3) points.push({ locX: flatPoints[i], locY: flatPoints[i + 1], locZ: flatPoints[i + 2] });
    return points;
};

// Per town: from the town's point a spur to where a body talks to each service
// NPC (the end of every way in) and from there back (the start of every way back);
// an NPC with no spur either way keeps today's leg there (spurFail, spurOneWay).
// Counted: the NPCs whose walk back as the reader takes it fails a leg on some
// way, and the (way, NPC) pairs whose walk in does.
function townSpurs(townKey, rows, counts) {
    const end = onFloor(TownRespawn.towns[townKey]);
    const ways = rows.map((row) => {
        const out = unpack(row.out);
        return { out, back: row.back ? unpack(row.back) : out.slice().reverse() };
    }).filter((way) => way.back.length);
    const spurs = [];
    for (const npc of TownServiceCatalog.rows().filter((row) => row.town === TownRespawn.towns[townKey].name)) {
        const at = onFloor(npc);
        const found = search(end, at, SPUR_NODES, SPUR_REACH);
        const toNpc = found.path && verified(densify([end, ...found.path.slice(1)]));
        if (!toNpc) { counts.spurFail++; continue; }
        const near = toNpc[toNpc.length - 1];
        let toEnd = verified(toNpc.slice().reverse());
        if (!toEnd) {
            const again = search(near, end, SPUR_NODES);
            toEnd = again.path && verified(densify([near, ...again.path.slice(1)]));
            if (!toEnd) { counts.spurOneWay++; continue; }
        }
        const reversed = toNpc.length === toEnd.length && toNpc.every((p, k) => sameCell(p, toEnd[toEnd.length - 1 - k]));
        spurs.push({ npc: npc.npcSelfId, at, from: near, toEnd, toNpc, reversed });
    }
    const townSpurs = spurs.map((spur) => spur.toEnd);
    for (const spur of spurs) {
        // Back: from the NPC along its spur and on to each way back, leg by leg as the reader picks.
        if (ways.some((way) => spur.toEnd.some((p) => !joins({ back: way.back, townSpurs }, p, false)))) counts.npcBackUnfixed++;
        // In: each way out continued by the spur to the NPC, its legs as the reader picks.
        if (spur.toNpc.length) {
            for (const way of ways) {
                const into = [...way.out, ...spur.toNpc.slice(1)];
                if (into.some((p, k) => { const target = TownWays.next(into, p); return target && target !== into[k + 1] && !legWalks(p, target); })) counts.npcIntoFail++;
            }
        }
    }
    counts.townSpurs += spurs.length;
    return spurs.map((spur) => ({ npc: spur.npc, at: [spur.at.locX, spur.at.locY, spur.at.locZ], points: pack(spur.toEnd),
        ...(spur.reversed ? {} : { toNpc: pack(spur.toNpc) }) }));
}

let TownRespawn, TownServiceCatalog, TownWays;

function spotsOf(catalogue, options) {
    let spots = catalogue.profiles.filter((spot) => spot.raidBoss !== true)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (options.spotIds) {
        const missing = options.spotIds.filter((id) => !spots.some((spot) => spot.id === id));
        if (missing.length) throw new Error(`--spot-ids: not hunting spots of the catalogue: ${missing.join(', ')}`);
        spots = spots.filter((spot) => options.spotIds.includes(spot.id));
    }
    return spots;
}

function near(spot) {
    const town = TownRespawn.getClosestTown(spot.center.locX, spot.center.locY, spot.center.locZ);
    return flat(spot.center, town) <= MAX_DISTANCE;
}

const emptyCounts = () => ({ oneWay: 0, spawnJoinFail: 0, spawnSpurs: 0, spawnJoinUnfixed: 0, townSpurs: 0,
    npcBackUnfixed: 0, npcIntoFail: 0, spurFail: 0, spurOneWay: 0 });
const addCounts = (into, from) => { for (const key of Object.keys(from)) into[key] = (into[key] || 0) + from[key]; return into; };

// The catalogue (the spot generator's) and the map the ways are searched on.
function setup() {
    const catalogue = require('./generate-spot-table').buildCatalogue();
    if (!catalogue.geodata) throw new Error('no geodata: the ways would be searched on no map (npm run geodata)');
    Geo = invoke('GameServer/Geodata/GeodataEngine');
    Geo.init();
    TownRespawn = invoke('GameServer/World/TownRespawn');
    TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
    TownWays = invoke('GameServer/Bot/Travel/TownWays');
    return catalogue;
}

async function main() {
    const options = args();
    const started = Date.now();
    const catalogue = setup();
    const spots = spotsOf(catalogue, options);
    const tasks = spots.filter(near);
    process.stderr.write(`catalogue: ${spots.length} hunting spots, ${tasks.length} within ${MAX_DISTANCE} u of their town, ${Math.round((Date.now() - started) / 1000)} s\n`);

    let results;
    const signature = tasks.map((spot) => spot.id).join(',');
    if (options.merge) {
        results = new Array(tasks.length);
        let found = 0;
        for (const name of fs.readdirSync(options.parts).filter((file) => file.endsWith('.json')).sort()) {
            const part = JSON.parse(fs.readFileSync(path.join(options.parts, name), 'utf8'));
            if (part.phase !== 'ways') continue;
            if (part.signature !== signature) throw new Error(`${name}: the parts of another catalogue`);
            part.indices.forEach((index, at) => { if (results[index] === undefined) found++; results[index] = part.results[at]; });
        }
        if (found !== tasks.length) throw new Error(`ways parts hold ${found} of ${tasks.length} spots`);
    } else {
        const share = tasks.map((spot, index) => ({ spot, index }))
            .filter(({ index }) => !options.shard || index % options.shard[1] === options.shard[0] - 1);
        results = [];
        let done = 0;
        for (const { spot } of share) {
            const counts = emptyCounts();
            const t0 = Date.now();
            const result = spotTask(spot, counts);
            results.push({ id: spot.id, ...result, counts, ms: Date.now() - t0 });
            if (++done % 20 === 0 || done === share.length) process.stderr.write(`  ${done}/${share.length} spots, ${Math.round((Date.now() - started) / 1000)} s\n`);
        }
        if (options.shard) {
            fs.mkdirSync(path.dirname(options.out), { recursive: true });
            fs.writeFileSync(options.out, `${JSON.stringify({ phase: 'ways', signature, indices: share.map(({ index }) => index), results })}\n`);
            process.stderr.write(`wrote ways part ${options.shard.join('/')}: ${share.length} of ${tasks.length} spots\n`);
            return;
        }
    }

    const counts = emptyCounts();
    const ways = {}, none = {};
    for (const result of results) {
        addCounts(counts, result.counts);
        if (result.row) ways[result.id] = result.row;
        else none[result.id] = result.none;
    }
    const towns = {};
    const byTown = new Map();
    for (const row of Object.values(ways)) byTown.set(row.town, [...(byTown.get(row.town) || []), row]);
    for (const townKey of [...byTown.keys()].sort()) {
        const spurs = townSpurs(townKey, byTown.get(townKey), counts);
        if (spurs.length) towns[townKey] = { spurs };
    }
    const table = {
        header: {
            schema: SCHEMA_VERSION,
            generator: 'scripts/generate-town-ways.js',
            revision: options.revision || gitRevision(),
            fingerprint: TableFingerprint.fingerprint('ways'),
            inputs: { geodata: catalogue.geodata, maxDistance: MAX_DISTANCE, maxNodes: MAX_NODES, spurNodes: SPUR_NODES,
                legMax: LEG_MAX, legClimb: LEG_CLIMB, legNodes: LEG_NODES, bisectDepth: BISECT_DEPTH },
            counts: { spots: spots.length, near: tasks.length, ways: Object.keys(ways).length, none: Object.keys(none).length,
                cap: Object.values(none).filter((reason) => reason === 'cap').length,
                closed: Object.values(none).filter((reason) => reason === 'closed').length,
                leg: Object.values(none).filter((reason) => reason === 'leg').length, ...counts },
            buildSeconds: Math.round((Date.now() - started) / 1000)
        },
        ways,
        towns,
        none
    };
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(table)}\n`);
    process.stderr.write(`wrote ${options.out}: ${JSON.stringify(table.header.counts)}\n`);
}

if (require.main === module) main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });

module.exports = { setup, spotTask, townSpurs, emptyCounts, near, MAX_DISTANCE };
