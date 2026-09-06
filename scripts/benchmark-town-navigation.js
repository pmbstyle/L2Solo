#!/usr/bin/env node
// Isolated routing benchmark: real geodata/workers, no server, database or players.
require('../src/Global');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { monitorEventLoopDelay } = require('perf_hooks');
const { BoundedPathfindingWorkerPool } = invoke('GameServer/Geodata/PathfindingWorkerPool');
const { TownNavigation } = invoke('GameServer/Bot/AI/TownNavigation');
const Corridor = invoke('GameServer/Geodata/TownPathCorridor');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');

const scenarios = [
    { town: 'Giran', region: [22, 22], startX: 83128, startY: 150280, startZ: -3512, endX: 83384, endY: 149256, endZ: -3400 },
    { town: 'Dion', region: [20, 22], startX: 18769, startY: 145629, startZ: -3108, endX: 19099, endY: 143987, endZ: -3071 }
];

async function measure(pool, scenario, count, shared, scattered = false) {
    const request = { ...scenario, maxNodes: 30000, goalRadius: 96, goalZTolerance: 64 };
    const inputs = Array.from({ length: count }, (_, index) => {
        if (!scattered) return request;
        const origin = { locX: request.startX, locY: request.startY, locZ: request.startZ };
        const candidate = { locX: origin.locX + (index % 5 - 2) * 16,
            locY: origin.locY + (Math.floor(index / 5) % 5 - 2) * 16, locZ: origin.locZ };
        candidate.locZ = Geodata.getHeight(candidate.locX, candidate.locY, candidate.locZ);
        if (!Corridor.visible(origin, candidate) || !Corridor.visible(candidate, origin)) return request;
        return { ...request, startX: candidate.locX, startY: candidate.locY, startZ: candidate.locZ };
    });
    const service = shared ? new TownNavigation(pool) : pool;
    const before = pool.stats();
    const delays = monitorEventLoopDelay({ resolution: 1 });
    delays.enable();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = performance.now();
    let cursor = 0;
    const paths = [];
    // Bound baseline admission as production does. Shared routes deliberately
    // receive the full burst to exercise fan-out and cooperative delivery.
    await Promise.all(Array.from({ length: shared ? count : Math.min(16, count) }, async () => {
        while (cursor < count) {
            const id = cursor++;
            paths[id] = await service.request(inputs[id], { key: `bot:${2002900 + id}`, priority: 50, timeoutMs: 15000 });
        }
    }));
    const elapsedMs = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 10));
    delays.disable();
    const after = pool.stats();
    let segments = 0, distance = 0, invalid = 0;
    // Validation is outside the measured delivery/event-loop window.
    for (const route of paths) {
        assert(route?.length > 1, 'benchmark route must reach its destination');
        for (let i = 1; i < route.length; i++) {
            segments++;
            distance += Corridor.distance(route[i - 1], route[i]);
            if (!Corridor.visible(route[i - 1], route[i])) invalid++;
        }
    }
    assert.strictEqual(invalid, 0, 'a faster route is unacceptable if it crosses blocked geodata');
    return { town: scenario.town, count, shared, scattered,
        uniqueStarts: new Set(inputs.map((r) => `${r.startX}:${r.startY}:${r.startZ}`)).size,
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        searches: after.queued - before.queued, workerMs: Math.round((after.workerMs - before.workerMs) * 100) / 100,
        eventLoopP95Ms: delays.percentile(95) / 1e6, eventLoopP99Ms: delays.percentile(99) / 1e6,
        eventLoopMaxMs: delays.max / 1e6, uniquePaths: new Set(paths.map((p) => JSON.stringify(p))).size,
        meanSegments: segments / count, meanDistance: Math.round(distance / count), invalidSegments: invalid,
        ...(shared ? { cache: service.stats() } : {}) };
}

async function run() {
    invoke('GameServer/Geodata/VirtualObstacles/index').init();
    for (const scenario of scenarios) assert(Geodata.loadRegion(...scenario.region));
    const pool = new BoundedPathfindingWorkerPool({ size: 1, queueLimit: 128 });
    const results = [];
    try {
        // Exclude worker startup/geodata loading from both comparisons.
        await pool.request({ startX: 83396, startY: 147904, startZ: -3404, endX: 83396, endY: 147904, endZ: -3404, maxNodes: 32 }, { timeoutMs: 15000 });
        for (const scenario of scenarios) for (const count of [25, 100, 250]) {
            for (const shared of [false, true]) {
                const result = await measure(pool, scenario, count, shared);
                results.push(result);
                console.log(JSON.stringify(result));
            }
        }
        for (const scenario of scenarios) for (const shared of [false, true]) {
            const result = await measure(pool, scenario, 250, shared, true);
            results.push(result);
            console.log(JSON.stringify(result));
        }
        const output = path.resolve(__dirname, '../tmp/town-navigation-benchmark.json');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), node: process.version,
            note: 'Routing and delivery only; meanSegments estimates movement packets per route before local steering. Not a full gameplay or client animation benchmark.', results }, null, 2));
        console.log(`Saved ${output}`);
    } finally { await pool.shutdown(); }
}
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { measure, scenarios };
