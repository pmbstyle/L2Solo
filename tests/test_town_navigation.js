const assert = require('assert');
require('../src/Global');
const { TownNavigation, POINT_LIMIT, CACHE_LIMIT } = invoke('GameServer/Bot/AI/TownNavigation');
const Corridor = invoke('GameServer/Geodata/TownPathCorridor');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');

async function run() {
    invoke('GameServer/Geodata/VirtualObstacles/index').init();
    assert(Geodata.loadRegion(22, 22), 'town navigation requires real Giran geodata');
    const request = { town: 'Giran', startX: 83128, startY: 150280, startZ: -3512,
        endX: 83384, endY: 149256, endZ: -3400, maxNodes: 30000, goalRadius: 96, goalZTolerance: 64 };
    const base = Geodata.findPath(request.startX, request.startY, request.startZ,
        request.endX, request.endY, request.endZ, request.maxNodes, { debug: false, goalRadius: 96, goalZTolerance: 64 });
    const corridor = Corridor.build(base);
    const budgetFallback = Corridor.build(base, () => { throw Object.assign(new Error('budget'), { code: 'PATH_BUDGET' }); });
    assert.deepStrictEqual(budgetFallback, { path: base, lanes: [] }, 'optional lane work must preserve an already found path when its budget expires');
    assert.throws(() => Corridor.build(base, () => { throw Object.assign(new Error('cancelled'), { code: 'STALE_PATH' }); }),
        { code: 'STALE_PATH' }, 'cancellation must not revive a journey through the budget fallback');
    assert(new Set(corridor.lanes.map((p) => JSON.stringify(p))).size >= 6,
        'the observed Giran train route must have several actual trajectories, not merely different final targets');
    for (const lane of corridor.lanes) for (let i = 1; i < lane.length; i++) {
        assert(Corridor.visible(lane[i - 1], lane[i]), 'every generated segment must remain on reachable geodata layers');
    }
    let requests = 0;
    const nav = new TownNavigation({ request: () => { requests++; return Promise.resolve(corridor); }, cancel() {} });
    const paths = await Promise.all(Array.from({ length: 250 }, (_, i) => nav.request(request, { key: `bot:${2002900 + i}`, priority: 50 })));
    assert.strictEqual(requests, 1, '250 concurrent town requests must share one expensive path calculation');
    assert(paths.every((p) => p?.length > 1));
    assert(new Set(paths.map((p) => JSON.stringify(p))).size >= 6);
    paths[0][1].locX = 0;
    assert(paths.slice(1).every((p) => p[1].locX !== 0), 'each executor must own its mutable path');
    assert((await nav.request(request, { key: 'bot:2002900', priority: 50 }))[1].locX !== 0,
        'movement must not mutate shared cached geometry');
    assert.strictEqual(requests, 1);
    assert.strictEqual(nav.stats().consumers, 0);

    let resolvePending, cancellations = 0;
    const pendingNav = new TownNavigation({
        request: () => new Promise((resolve) => { resolvePending = resolve; }),
        cancel() { cancellations++; }
    });
    const first = pendingNav.request(request, { key: 'bot:1' }).catch((e) => e.code);
    const second = pendingNav.request(request, { key: 'bot:2' });
    pendingNav.cancel('bot:1');
    assert.strictEqual(await first, 'STALE_PATH');
    assert.strictEqual(cancellations, 0, 'one cancelled passenger must not cancel everyone sharing its corridor');
    resolvePending(corridor);
    assert((await second).length > 1);
    const cached = pendingNav.request(request, { key: 'bot:2' }).catch((e) => e.code);
    pendingNav.cancel('bot:2');
    assert.strictEqual(await cached, 'STALE_PATH', 'cached deliveries must also respect cancellation');
    const orphan = pendingNav.request({ ...request, endY: request.endY + 512 }, { key: 'bot:3' }).catch((e) => e.code);
    pendingNav.cancel('bot:3');
    assert.strictEqual(await orphan, 'STALE_PATH');
    assert.strictEqual(cancellations, 1, 'no remaining passengers must cancel the worker search');
    resolvePending(null);

    const revisionNav = new TownNavigation({
        request: () => new Promise((resolve) => { resolvePending = resolve; }), cancel() {}
    });
    const oldGeometry = revisionNav.request(request, { key: 'bot:revision' }).catch((e) => e.code);
    Geodata.navigationRevision = Number(Geodata.navigationRevision || 0) + 1;
    resolvePending(corridor);
    assert.strictEqual(await oldGeometry, 'STALE_PATH', 'geometry reload must reject paths already in flight');
    assert.strictEqual(revisionNav.stats().pending, 0);
    assert.strictEqual(revisionNav.stats().consumers, 0);

    await nav.request(request, { key: 'bot:revision-cache' });
    const oldCachedGeometry = nav.request(request, { key: 'bot:revision-cache' }).catch((e) => e.code);
    Geodata.navigationRevision++;
    assert.strictEqual(await oldCachedGeometry, 'STALE_PATH', 'queued cache deliveries must also reject old geometry');

    const originalVisible = Corridor.visible;
    try {
        Corridor.visible = () => true;
        let calls = 0;
        const layerNav = new TownNavigation({ request(r) {
            calls++;
            return Promise.resolve({ path: [
                { locX: r.startX, locY: r.startY, locZ: r.startZ },
                { locX: r.endX, locY: r.endY, locZ: r.endZ }
            ], lanes: [] });
        }, cancel() {} });
        await layerNav.request(request, { key: 'bot:1' });
        await layerNav.request({ ...request, startZ: request.startZ + 128, endZ: request.endZ + 128 }, { key: 'bot:2' });
        assert.strictEqual(calls, 2, 'different floors must not share cached routes');
        Geodata.navigationRevision = Number(Geodata.navigationRevision || 0) + 1;
        await layerNav.request(request, { key: 'bot:3' });
        assert.strictEqual(calls, 3, 'geometry revisions must invalidate old cache keys');

        const blockedNav = new TownNavigation({ request(r) {
            return Promise.resolve(r.startX === request.startX ? null : { path: [
                { locX: r.startX, locY: r.startY, locZ: r.startZ },
                { locX: r.endX, locY: r.endY, locZ: r.endZ }
            ], lanes: [] });
        }, cancel() {} });
        const blocked = blockedNav.request(request, { key: 'bot:10' });
        const adjacent = blockedNav.request({ ...request, startX: request.startX + 1 }, { key: 'bot:11' });
        assert.strictEqual(await blocked, null);
        assert((await adjacent)?.length, 'a failed point must not poison a different start in the same tile');
    } finally { Corridor.visible = originalVisible; }

    for (let i = 0; i < 1000; i++) nav.store(`memory:${i}`, corridor);
    assert(nav.stats().points <= POINT_LIMIT && nav.stats().entries <= CACHE_LIMIT, 'shared caches must remain bounded');
    let checks = 0;
    assert.throws(() => Geodata.findPath(83128, 150280, -3512, 83384, 149256, -3400, 30000, {
        debug: false, checkBudget() { if (++checks > 2) throw Object.assign(new Error('cancelled'), { code: 'STALE_PATH' }); }
    }), { code: 'STALE_PATH' }, 'A* must check cancellation inside the search');
    console.log('Shared town corridor, diversity, cancellation, layer and memory checks passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
