const assert = require('assert');
require('../src/Global');
const Recovery = invoke('GameServer/Geodata/PlayerTransitionRecovery');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const RequestMove = invoke('GameServer/Network/Request/MoveToLocation');
const Validate = invoke('GameServer/Network/Request/ValidatePosition');
const Move = invoke('GameServer/Actor/Generics/MoveTo');
const ingress = Recovery.transitions.find(t => t.id === 'ti-magic-shop-in');
const egress = Recovery.transitions.find(t => t.id === 'ti-magic-shop-out');
assert(ingress && egress, 'The captured doorway needs both travel directions');

const depth = (t, p) => (p.locX - t.x) * t.nx + (p.locY - t.y) * t.ny;
function point(t, distance, offset = 0) {
    return { locX: Math.round(t.x + t.nx * distance - t.ny * offset),
        locY: Math.round(t.y + t.ny * distance + t.nx * offset), locZ: -3720 };
}
function fixture(t = ingress, from = point(t, 0)) {
    let loc = { ...from, head: 123 };
    const packets = [], s = { accountId: 'ti_door_test', moveRouteGeneration: 0 };
    const a = s.actor = {
        effects: {}, fetchId: () => 2007858, fetchSize: () => 23,
        fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ, fetchHead: () => loc.head,
        fetchCollectiveRunSpd: () => 200, isDead: () => false, isBlocked: () => false,
        automation: { abortAll() { s.moveRouteGeneration++; } },
        updatePosition(p) { loc = { ...loc, ...p }; },
        moveTo(coords) { Move(s, a, coords); }
    };
    s.dataSendToMeAndOthers = p => packets.push(p);
    return { s, a, packets, from, to: point(t, 80), loc: () => loc };
}
function corrected(f, t) {
    assert.deepStrictEqual(f.packets.map(p => p[0]), [0x61, 1], t.id);
    assert(Math.abs(depth(t, f.loc()) - 32) < 1, 'Land beyond the complete threshold gap');
    assert.strictEqual(f.packets[1].readInt32LE(17), f.loc().locX);
    assert.strictEqual(f.packets[1].readInt32LE(21), f.loc().locY);
    assert.strictEqual(f.packets[1].readInt32LE(5), f.to.locX, 'Continue toward the clicked destination');
    assert.strictEqual(f.loc().head, 123);
}
function packet(opcode, values) {
    const p = Buffer.alloc(1 + values.length * 4);
    p[0] = opcode;
    values.forEach((value, i) => p.writeInt32LE(value, 1 + 4 * i));
    return p;
}

const originals = Object.fromEntries(['hasGeo', 'getCellData', 'hasLineOfSight'].map(k => [k, Geo[k]]));
// A diagonal missing-floor strip between two intact aprons. Sources inside it
// resolve to the roof; no ordinary geodata line of sight can cross it.
const physicalDepth = (x, y) => ((x + 84497) - (y - 240840)) * Math.SQRT1_2;
const cell = (x, y) => {
    const d = physicalDepth(x, y);
    return { z: d > -8 && d < 28 ? -3360 : d < 0 ? -3728 : -3720, nswe: 15 };
};
const clear = (x, y, z, endX, endY) => {
    const a = physicalDepth(x, y), b = physicalDepth(endX, endY);
    return Math.max(a, b) <= -8 || Math.min(a, b) >= 28;
};
try {
    Geo.hasGeo = () => true;
    Geo.getCellData = cell;
    Geo.hasLineOfSight = clear;
    for (const t of [ingress, egress]) {
        for (const offset of [-27, -20, 0, 20, 27]) {
            const f = fixture(t, point(t, 0, offset));
            Recovery.command(f.s, f, 10000);
            corrected(f, t);
        }
        const insideThreshold = fixture(t, point(t, 20, 20));
        Recovery.command(insideThreshold.s, insideThreshold, 10000);
        corrected(insideThreshold, t);
        const landed = { ...insideThreshold.loc() };
        assert(Recovery.observe(insideThreshold.s, insideThreshold.from, 10100));
        assert.deepStrictEqual(insideThreshold.loc(), landed, 'Late reports from deeper in the threshold stay suppressed');
        for (const mutate of [
            f => { f.from = point(t, 0, 64); f.a.updatePosition(f.from); },
            f => { f.to = point(t, 16); },
            f => { f.from.locZ += 200; f.a.updatePosition(f.from); },
            f => { f.a.isDead = () => true; },
            f => { f.a.isBlocked = () => true; },
            f => { f.a.fakeDeath = true; },
            f => { f.a.stateWater = true; },
            f => { f.a.boatId = 1; },
            f => { f.a.isFlying = () => true; },
            f => { f.s.accountId = 'bot_door_test'; },
            f => { f.a.updatePosition({ locX: 0, locY: 0, locZ: 0 }); }
        ]) {
            const f = fixture(t); mutate(f);
            Recovery.command(f.s, f, 10000);
            assert.strictEqual(f.packets.length, 0, 'Do not bridge outside the aperture, past the clicked point, on another floor or for disabled actors');
            Recovery.cancel(f.s);
        }
        // A gap exception must still reject missing floor/coverage and walls
        // on either apron, including behind the reported source position.
        for (const override of [
            { hasGeo: () => false },
            { hasGeo: (x, y) => physicalDepth(x, y) > -30 },
            { getCellData: (x, y) => physicalDepth(x, y) < -30 ? { z: -3500, nswe: 15 } : cell(x, y) },
            { getCellData: (x, y) => physicalDepth(x, y) > 30 ? { z: -3500, nswe: 15 } : cell(x, y) },
            { hasLineOfSight: (x, y, ...rest) => physicalDepth(x, y) > 0 && clear(x, y, ...rest) },
            { hasLineOfSight: (x, y, ...rest) => physicalDepth(x, y) < 0 && clear(x, y, ...rest) }
        ]) {
            const old = Object.fromEntries(Object.keys(override).map(k => [k, Geo[k]]));
            Object.assign(Geo, override);
            try {
                const f = fixture(t);
                Recovery.command(f.s, f, 10000);
                assert.strictEqual(f.packets.length, 0, 'Both sides of the doorway must remain usable');
                Recovery.cancel(f.s);
            } finally { Object.assign(Geo, old); }
        }
    }
    const clock = Date.now, timeout = global.setTimeout, clearTimeoutOriginal = global.clearTimeout;
    let now = 20000, pending;
    Date.now = () => now;
    global.setTimeout = (fn, delay) => (pending = { fn, delay, unref() {} });
    global.clearTimeout = () => {};
    try {
        for (const t of [ingress, egress]) {
            const f = fixture(t, point(t, -120));
            Recovery.command(f.s, f);
            assert.strictEqual(f.packets.length, 0, 'Approaching the shop must not relocate early');
            assert(pending.delay > 450 && pending.delay < 550, 'Predict only travel to the intact near apron');
            now += pending.delay; pending.fn();
            corrected(f, t);
            now += 10000;
            for (const stop of [
                f => Recovery.cancel(f.s),
                f => f.a.automation.abortAll(),
                f => { f.a.isDead = () => true; },
                f => { f.a.fetchCollectiveRunSpd = () => 100; }
            ]) {
                const interrupted = fixture(t, point(t, -120));
                Recovery.command(interrupted.s, interrupted);
                const scheduled = pending; stop(interrupted);
                now += scheduled.delay; scheduled.fn();
                assert.strictEqual(interrupted.packets.length, 0, 'Cancelled or changed approaches must not fire');
                now += 10000;
            }
            const angled = fixture(t, point(t, -120, 60));
            Recovery.command(angled.s, angled);
            assert.deepStrictEqual(angled.packets.map(p => p[0]), [1], 'A single oblique click steers toward the clear opening');
            const approach = angled.s.transitionAttempt.approach;
            assert(Math.abs(depth(t, approach) + 24) < 1);
            assert(Math.abs((approach.locX - t.x) * -t.ny + (approach.locY - t.y) * t.nx) < 21);
            now += pending.delay; pending.fn();
            angled.packets.shift(); corrected(angled, t);
            now += 10000;

            const jamb = fixture(t, point(t, 2, 35));
            pending = null;
            Recovery.command(jamb.s, jamb);
            assert.deepStrictEqual(jamb.packets.map(p => p[0]), [1], 'Walk away from a jamb toward the near apron');
            assert.strictEqual(pending, null, 'Do not predict a warp from an obstructed source');
            assert.deepStrictEqual(jamb.loc(), { ...jamb.from, head: 123 });
            const apron = jamb.s.transitionAttempt.approach;
            jamb.a.updatePosition(apron);
            Recovery.observe(jamb.s, apron);
            jamb.packets.shift(); corrected(jamb, t);
            now += 10000;
        }
        const from = { locX: -84494, locY: 240840, locZ: -3720 };
        const f = fixture(ingress, from);
        RequestMove(f.s, packet(1, [f.to.locX, f.to.locY, f.to.locZ - 23, from.locX, from.locY, from.locZ, 1]));
        assert.deepStrictEqual(f.packets.map(p => p[0]), [1, 0x61, 1], 'Exercise the real client request and correction packets');
        const landing = { ...f.loc() };
        now += 100;
        Validate(f.s, packet(0x48, [from.locX, from.locY, from.locZ, 123, 0]));
        assert.deepStrictEqual(f.loc(), landing, 'A late pre-crossing position must not undo the correction');
        assert.deepStrictEqual(Recovery.source(f.s, from), { locX: landing.locX, locY: landing.locY, locZ: landing.locZ });
        now += 700;
        Recovery.command(f.s, { from, to: f.to });
        assert.strictEqual(f.packets.length, 3, 'Keep the ordinary correction cooldown');
        Recovery.cancel(f.s);

        const roundTrip = fixture(ingress);
        Recovery.command(roundTrip.s, roundTrip);
        corrected(roundTrip, ingress);
        for (const t of [egress, ingress]) {
            now += 100;
            roundTrip.from = { ...roundTrip.loc() };
            roundTrip.to = point(t, 80);
            roundTrip.packets.length = 0;
            Recovery.command(roundTrip.s, roundTrip);
            corrected(roundTrip, t);
        }
        Recovery.cancel(roundTrip.s);
    } finally {
        Date.now = clock; global.setTimeout = timeout; global.clearTimeout = clearTimeoutOriginal;
    }
} finally { Object.assign(Geo, originals); }

require('./helpers/verify_geodata_when_available')(Geo, [[17, 25]], 'Talking Island magic shop threshold', () => {
    const captured = fixture(ingress, { locX: -84494, locY: 240840, locZ: -3720 });
    Recovery.command(captured.s, captured, 10000);
    corrected(captured, ingress);
    assert.deepStrictEqual(captured.loc(), { locX: -84473, locY: 240819, locZ: -3720, head: 123 });
    for (const t of [ingress, egress]) {
        for (const offset of [-27, -20, -8, 0, 8, 20, 27]) {
            for (const start of [-24, 0, 5, 12, 20, 23]) {
                const f = fixture(t, point(t, start, offset));
                Recovery.command(f.s, f, 10000);
                corrected(f, t);
                assert(Math.hypot(f.loc().locX - f.from.locX, f.loc().locY - f.from.locY) < 58,
                    'The correction stays within the measured threshold');
                assert(Math.abs(f.loc().locZ + 3720) <= 8, 'Land on the installed ground floor');
            }
        }
    }
    const clock = Date.now, timeout = global.setTimeout, clearTimeoutOriginal = global.clearTimeout;
    let now = 10000, pending;
    Date.now = () => now;
    global.setTimeout = (fn, delay) => (pending = { fn, delay, unref() {} });
    global.clearTimeout = () => {};
    try {
        for (const t of [ingress, egress]) {
            for (const [distance, offset] of [[-120, -60], [-120, 60], [2, -35], [2, 35]]) {
                const f = fixture(t, point(t, distance, offset));
                pending = null;
                Recovery.command(f.s, f);
                assert.deepStrictEqual(f.packets.map(p => p[0]), [1], `${t.id}: align oblique and jamb approaches on the installed map`);
                const approach = f.s.transitionAttempt.approach;
                if (distance < 0) {
                    assert(pending, 'A clear oblique approach predicts its arrival');
                    now += pending.delay; pending.fn();
                } else {
                    assert.strictEqual(pending, null, 'An obstructed source waits for a real approach report');
                    f.a.updatePosition(approach);
                    Recovery.observe(f.s, approach);
                }
                f.packets.shift(); corrected(f, t);
                Recovery.cancel(f.s);
                now += 10000;
            }
        }
    } finally {
        Date.now = clock; global.setTimeout = timeout; global.clearTimeout = clearTimeoutOriginal;
    }
});
console.log('Talking Island magic shop transition checks passed');
