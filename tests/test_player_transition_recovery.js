const assert = require('assert');
require('../src/Global');
const Recovery = invoke('GameServer/Geodata/PlayerTransitionRecovery');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const RequestMove = invoke('GameServer/Network/Request/MoveToLocation');
const Validate = invoke('GameServer/Network/Request/ValidatePosition');
const Move = invoke('GameServer/Actor/Generics/MoveTo');
function fixture(t = Recovery.transitions[0]) {
    let loc = { locX: Math.round(t.x), locY: Math.round(t.y), locZ: t.z, head: 123 };
    const packets = [], s = { accountId: 'transition_test', moveRouteGeneration: 0 };
    const a = s.actor = {
        effects: {}, session: s, fetchId: () => 2000224, fetchSize: () => 23,
        fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ, fetchHead: () => loc.head,
        isDead: () => false, isBlocked: () => false,
        automation: { abortAll() { s.moveRouteGeneration++; } },
        updatePosition(p) { loc = { ...loc, ...p }; },
        moveTo(coords) { Move(s, a, coords); }
    };
    s.dataSendToMeAndOthers = p => { packets.push(p); };
    const from = { ...loc }, to = { locX: Math.round(t.x + t.nx * 70), locY: Math.round(t.y + t.ny * 70), locZ: t.z };
    return { s, a, packets, from, to, loc: () => loc };
}
const originals = Object.fromEntries(['hasGeo', 'getCellData', 'hasLineOfSight'].map(k => [k, Geo[k]]));
try {
    Geo.hasGeo = () => true;
    Geo.getCellData = (x, y, z) => ({ z: z + 8, nswe: 15 });
    Geo.hasLineOfSight = () => true;
    let f = fixture();
    Recovery.command(f.s, f, 10000);
    assert.deepStrictEqual(f.packets.map(p => p[0]), [0x61, 1], 'Correct immediately and resume the requested move without teleport');
    assert.deepStrictEqual(Array.from({ length: 5 }, (_, i) => f.packets[0].readInt32LE(1 + i * 4)),
        [2000224, f.loc().locX, f.loc().locY, f.loc().locZ, 123], 'C4 ValidateLocation wire fields before normal packet padding');
    assert.strictEqual(f.packets[1].readInt32LE(5), f.to.locX);
    assert.strictEqual(f.packets[1].readInt32LE(17), f.loc().locX);
    assert(Recovery.observe(f.s, f.from, 10100), 'Late old position must not undo correction');
    assert.deepStrictEqual(Recovery.source(f.s, f.from, 10100), { locX: f.loc().locX, locY: f.loc().locY, locZ: f.loc().locZ });
    Recovery.command(f.s, f, 11000);
    assert.strictEqual(f.packets.length, 2, 'Cooldown blocks repeated corrections');
    for (const mutate of [
        f => { f.to.locX = f.from.locX + 100; },
        f => { f.from.locY += 100; },
        f => { f.from.locZ += 200; },
        f => { f.a.isDead = () => true; },
        f => { f.a.isBlocked = () => true; },
        f => { f.a.fakeDeath = true; },
        f => { f.a.stateWater = true; },
        f => { f.a.boatId = 1; },
        f => { f.s.accountId = 'bot_test'; },
        f => { f.a.updatePosition({ locX: 0, locY: 0, locZ: 0 }); }
    ]) {
        f = fixture(); mutate(f); Recovery.command(f.s, f, 10000);
        assert.strictEqual(f.packets.length, 0);
    }
    const approach = f => ({ from: { ...f.from, locX: f.from.locX + 100 }, to: f.to });
    for (const interrupt of [f => Recovery.cancel(f.s), f => f.a.automation.abortAll(), f => { f.a.isDead = () => true; }]) {
        f = fixture(); Recovery.command(f.s, approach(f), 10000); interrupt(f); Recovery.observe(f.s, f.from, 10300);
        assert.strictEqual(f.packets.length, 0);
    }
    f = fixture(); Recovery.command(f.s, approach(f), 10000);
    assert.strictEqual(f.packets.length, 0, 'Do not correct before reaching the narrow boundary');
    assert(Recovery.observe(f.s, f.from, 10001), 'First boundary report triggers without waiting');
    f = fixture(); Recovery.command(f.s, approach(f), 10000);
    Recovery.command(f.s, { from: f.from, to: { ...f.from, locX: f.from.locX + 100 } }, 10001);
    Recovery.observe(f.s, f.from, 10002);
    assert.strictEqual(f.packets.length, 0, 'Redirection outward cancels approach');
    for (const override of [{ hasGeo: () => false }, { hasLineOfSight: () => false }, { getCellData: () => ({ z: 0 }) }]) {
        const old = Object.fromEntries(Object.keys(override).map(k => [k, Geo[k]])); Object.assign(Geo, override);
        f = fixture(); Recovery.command(f.s, f, 10000);
        assert.strictEqual(f.packets.length, 0, 'Reject missing geo, walls and remote layers');
        Object.assign(Geo, old);
    }
    const oldNow = Date.now; let now = 10000; Date.now = () => now;
    try {
        f = fixture();
        const packet = (op, values) => { const b = Buffer.alloc(1 + values.length * 4); b[0] = op; values.forEach((v, i) => b.writeInt32LE(v, 1 + i * 4)); return b; };
        RequestMove(f.s, packet(1, [f.to.locX, f.to.locY, f.to.locZ - 23, f.from.locX, f.from.locY, f.from.locZ, 1]));
        assert.deepStrictEqual(f.packets.map(p => p[0]), [1, 0x61, 1]);
        const corrected = { ...f.loc() }; now += 100;
        Validate(f.s, packet(0x48, [f.from.locX, f.from.locY, f.from.locZ, 123, 0]));
        assert.deepStrictEqual(f.loc(), corrected);
    } finally { Date.now = oldNow; }
    // No client packet is needed between the final approach and correction.
    const clock = Date.now, timeout = global.setTimeout, clear = global.clearTimeout;
    now = 20000; let pending;
    Date.now = () => now;
    global.setTimeout = (fn, delay) => (pending = { fn, delay, unref() {} });
    global.clearTimeout = handle => { if (handle) handle.cancelled = true; };
    try {
        f = fixture(); f.a.fetchCollectiveRunSpd = () => 200;
        const start = { ...f.from, locX: f.from.locX + 120 };
        f.a.updatePosition(start);
        Recovery.command(f.s, { from: start, to: f.to });
        assert(pending.delay > 500 && pending.delay < 700);
        assert.strictEqual(f.packets.length, 0);
        now += pending.delay; pending.fn();
        assert.deepStrictEqual(f.packets.map(p => p[0]), [0x61, 1]);
        for (const stop of [f => Recovery.cancel(f.s), f => f.a.automation.abortAll(), f => { f.a.isDead = () => true; }, f => { f.a.fetchCollectiveRunSpd = () => 100; }]) {
            now += 10000; f = fixture(); f.a.fetchCollectiveRunSpd = () => 200; f.a.updatePosition(start);
            Recovery.command(f.s, { from: start, to: f.to });
            const scheduled = pending; stop(f); now += scheduled.delay; scheduled.fn();
            assert.strictEqual(f.packets.length, 0, 'Cancelled, disabled or changed-speed prediction must not fire');
        }
        now += 10000; f = fixture(); f.a.fetchCollectiveRunSpd = () => 200;
        const distant = { ...f.from, locX: f.from.locX + 800, locY: f.from.locY + 60 };
        Recovery.command(f.s, { from: distant, to: f.to });
        assert(f.s.transitionAttempt, 'A distant diagonal click crossing the doorway arms the local approach');
        f.a.updatePosition(start); Recovery.observe(f.s, start);
        const scheduled = pending; now += scheduled.delay; scheduled.fn();
        assert.deepStrictEqual(f.packets.map(p => p[0]), [0x61, 1]);
    } finally { Date.now = clock; global.setTimeout = timeout; global.clearTimeout = clear; }
} finally { Object.assign(Geo, originals); }
require('./helpers/verify_geodata_when_available')(Geo, [[24, 18], [23, 20], [17, 25]], 'Town transition recovery destinations', () => {
    for (const t of Recovery.transitions) {
        const f = fixture(t); Recovery.command(f.s, f, 10000);
        assert.deepStrictEqual(f.packets.map(p => p[0]), [0x61, 1], t.id);
        assert(Math.hypot(f.loc().locX - f.from.locX, f.loc().locY - f.from.locY) < 40);
    }
    const t = Recovery.transitions.find(t => t.id === 'hunters-stair');
    for (const offset of [-110, -80, 0, 80, 110, -150, 150]) {
        const f = fixture(t);
        const from = { locX: Math.round(t.x - t.ny * offset), locY: Math.round(t.y + t.nx * offset), locZ: -2713 };
        const to = { locX: Math.round(from.locX + t.nx * 70), locY: Math.round(from.locY + t.ny * 70), locZ: -2680 };
        f.a.updatePosition(from);
        Recovery.command(f.s, { from, to }, 10000);
        const end = { locX: Math.round(from.locX + t.nx * 32), locY: Math.round(from.locY + t.ny * 32) };
        end.locZ = Geo.getHeight(end.locX, end.locY, from.locZ);
        const clear = Math.abs(offset) <= t.width && Math.abs(end.locZ - from.locZ) <= 64
            && Geo.hasLineOfSight(from.locX, from.locY, from.locZ, end.locX, end.locY, end.locZ);
        assert.deepStrictEqual(f.packets.map(p => p[0]), clear ? [0x61, 1] : [],
            `Stair lateral offset ${offset} must respect the installed geometry`);
    }
});
console.log('Player transition recovery checks passed');
