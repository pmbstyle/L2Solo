const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');

// The town way a body walks between its spot and its town (TownWays): where it
// joins the way, how it follows it without turning back, the way back, and the
// spurs from a town's NPCs and a spot's spawn points onto the way.
const TownWays = invoke('GameServer/Bot/Travel/TownWays');
const FailureLog = require('../src/FailureLog');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-ways-'));
const file = path.join(dir, 'town-ways.json');
const p = (locX, locY, locZ = 0) => ({ locX, locY, locZ });
// A way east along y = 0 with a hairpin: point 7 comes back within 100 u of point 2.
const out = [p(0, 0), p(500, 0), p(1000, 0), p(1500, 0), p(2000, 0), p(2000, 500), p(1500, 500), p(1000, 90), p(500, 900), p(0, 1400)];
const flat = (points) => points.flatMap((point) => [point.locX, point.locY, point.locZ]);
const backDetour = [p(0, 1400), p(-500, 700), p(0, 0)];
const npcSpur = [p(0, 6400), p(0, 5900), p(0, 1400)];
const spawnSpur = [p(-3000, -800), p(-1500, -400), p(0, 0)];
fs.writeFileSync(file, JSON.stringify({
    header: { generator: 'scripts/generate-town-ways.js' },
    ways: {
        a: { town: 'hunters_village', out: flat(out), spurs: [{ points: flat(spawnSpur) }] },
        b: { town: 'hunters_village', out: flat(out), back: flat(backDetour) }
    },
    towns: { hunters_village: { spurs: [{ npc: 7301, points: flat(npcSpur) }] } },
    none: { c: 'cap' }
}));

try {
    TownWays.useFile(file);
    const way = TownWays.way('a');
    assert.equal(way.townName, "Hunter's Village");
    assert.deepStrictEqual(way.start, p(0, 0));
    assert.equal(TownWays.way('c'), null, 'a spot the build found no way for has none');
    assert.equal(TownWays.way('unknown'), null);

    // Joining: the nearest point on the body's floor within JOIN; a point 300 u above is not on it.
    assert.deepStrictEqual(TownWays.next(way.out, p(1900, -900)), p(2000, 0));
    assert.deepStrictEqual(TownWays.next(way.out, p(1900, -900, 300)), null, 'no way point on the body\'s floor');
    assert.equal(TownWays.next(way.out, p(9000, -9000)), null, 'beyond JOIN the way does not apply');
    // Following: at a point, the next one; at the last, the way ends.
    assert.deepStrictEqual(TownWays.next(way.out, p(1510, 10)), p(2000, 0));
    assert.equal(TownWays.next(way.out, p(0, 1400)), null);
    // The hairpin: a body at point 7 (within 100 u of point 2) goes on to 8, never back to 3
    // (the build checks the leg from point 2 to 8 too: every leg as the reader takes it).
    assert.deepStrictEqual(TownWays.next(way.out, p(1000, 90)), p(500, 900));

    // Back: the reverse of the way, or the way the build stored for the walk back.
    assert.deepStrictEqual(TownWays.next(way.back, p(1500, 500)), p(2000, 500));
    assert.deepStrictEqual(TownWays.next(TownWays.way('b').back, p(0, 1400)), p(-500, 700));
    // The walk back's end is the spot's centre, on its floor.
    assert.equal(TownWays.atStart(way, p(100, 100)), true);
    assert.equal(TownWays.atStart(way, p(400, 0)), false);
    assert.equal(TownWays.atStart(way, p(0, 0, 400)), false);

    // A town NPC's spur: taken at the NPC (a body talking stands within SPUR_ENTRY of
    // it) in that town, followed to the town end of the way, then the way back.
    assert.deepStrictEqual(TownWays.wayPoint(way, p(0, 6680), false, true), p(0, 5900), 'the spur from the NPC');
    assert.deepStrictEqual(TownWays.wayPoint(way, p(0, 5900), false, false), p(0, 1400), 'once on the spur, on past the town\'s edge');
    assert.deepStrictEqual(TownWays.wayPoint(way, p(0, 1400), false, true), p(500, 900), 'at its end the way back');
    assert.equal(TownWays.wayPoint(way, p(0, 6680), false, false), null, 'out of the town no spur: beyond JOIN, no way');
    // A body on the way back keeps to it even within reach of a spur point.
    assert.deepStrictEqual(TownWays.wayPoint(way, p(30, 1420), false, true), p(500, 900));
    // The walk in to a town NPC goes on past the way's end along that NPC's spur, to the NPC;
    // to any other target the way ends at the town end.
    assert.deepStrictEqual(TownWays.wayPoint(way, p(0, 1400), true, false, p(100, 6450)), p(0, 5900));
    assert.deepStrictEqual(TownWays.wayPoint(way, p(0, 5900), true, false, p(100, 6450)), p(0, 6400));
    assert.equal(TownWays.wayPoint(way, p(0, 1400), true, false, p(900, 6450)), null);
    // A spawn point's spur out to the spot's centre, then the way out.
    assert.deepStrictEqual(TownWays.wayPoint(way, p(-3100, -900), true), p(-1500, -400));
    assert.deepStrictEqual(TownWays.wayPoint(way, p(-1500, -400), true), p(0, 0));
    assert.deepStrictEqual(TownWays.wayPoint(way, p(0, 0), true), p(500, 0));

    // A server without its ways: no way anywhere, the failure counted.
    const counted = () => FailureLog.snapshot()?.['TownWays.load'] || 0;
    const before = counted();
    TownWays.useFile(path.join(dir, 'missing.json'));
    assert.equal(TownWays.way('a'), null);
    assert.equal(counted(), before + 1, 'a missing table is counted');
} finally {
    TownWays.useFile();
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('Town ways reader checks passed');
