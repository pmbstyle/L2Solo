const assert = require('assert');
require('../src/Global');
const { TownTraffic, MAX_CANDIDATES } = invoke('GameServer/Bot/AI/TownTraffic');
const Corridor = invoke('GameServer/Geodata/TownPathCorridor');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const clear = Corridor.clearSegment, height = Geodata.getHeight;
try {
    Corridor.clearSegment = () => true;
    Geodata.getHeight = (_x, _y, z) => z;
    const point = { locX: 0, locY: 0, locZ: 0 };
    const target = { locX: 400, locY: 0, locZ: 0 };
    const actor = { fetchId: () => 20, fetchCollectiveRunSpd: () => 120 };
    const traffic = new TownTraffic();
    traffic.update(10, { locX: 60, locY: 0, locZ: 0 }, target, 0, 1000);
    const session = {};
    const detour = traffic.steer(session, actor, point, target, 100, 1000);
    assert(detour?.point && detour.point.locY !== 0, 'a close obstruction must produce a lateral detour when geodata allows it');
    assert.strictEqual(traffic.steer(session, actor, point, target, 100, 1500), null,
        'steering must not constantly reannounce different movement segments');
    Corridor.clearSegment = () => false;
    traffic.spentMs = 0;
    const blocked = traffic.steer({}, actor, point, target, 100, 1000);
    assert(blocked?.waitMs > 0, 'a narrow blocked passage must yield rather than clip a wall');
    const queries = traffic.stats().queries;
    assert.strictEqual(traffic.steer({}, actor, point, target, 6000, 1000), null);
    assert.strictEqual(traffic.stats().queries, queries, 'far visible actors must not pay for local avoidance');
    traffic.update(10, { locX: 60, locY: 0, locZ: 128 }, target, 0, 1000);
    traffic.spentMs = 0;
    assert.strictEqual(traffic.steer({}, actor, point, target, 100, 1000), null, 'neighbors on other floors must not interfere');

    for (const count of [25, 100, 250]) {
        const dense = new TownTraffic();
        for (let id = 1; id <= count; id++) dense.update(id, { locX: id % 50, locY: id % 40, locZ: 0 }, target, 0, 1000);
        const neighbors = dense.neighbors(9999, point, 1000);
        assert(neighbors.length <= 8);
        assert(dense.stats().maxCandidates <= MAX_CANDIDATES, 'dense cells must not turn into an unbounded scan');
        assert.strictEqual(dense.neighbors(9999, point, 10000).length, 0, 'cooled or removed actors must not remain as ghost obstacles');
    }
    const budgeted = new TownTraffic();
    budgeted.windowAt = performance.now();
    budgeted.spentMs = 2;
    assert.strictEqual(budgeted.steer({}, actor, point, target, 100, 1000), null);
    assert.strictEqual(budgeted.stats().deferred, 1, 'decorative avoidance must yield the shared main-thread budget');
    for (let id = 0; id < 5000; id++) budgeted.update(id, point, target, 0, 1000);
    assert(budgeted.stats().actors <= 2048, 'traffic occupancy memory must remain bounded');
    console.log('Town traffic, narrow passage, density, LOD and budget checks passed');
} finally { Corridor.clearSegment = clear; Geodata.getHeight = height; }
