const assert = require('assert');

require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;

const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownGateCatalog = invoke('GameServer/Bot/AI/TownGateCatalog');
const BotAI = invoke('GameServer/Bot/BotAI');

function distance(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function assertNotSameLoc(actual, expected, message) {
    assert(
        actual.locX !== expected.locX || actual.locY !== expected.locY || actual.locZ !== expected.locZ,
        message
    );
}

function routeUntilTarget(from, to, maxSteps = 6) {
    const steps = [];
    let current = { ...from };
    for (let i = 0; i < maxSteps; i++) {
        const next = TownPathfinder.route(null, current, to);
        steps.push(next);
        if (next.locX === to.locX && next.locY === to.locY && next.locZ === to.locZ) {
            return steps;
        }
        current = { ...next };
    }
    return steps;
}

const giranCenter = { locX: 83396, locY: 147904, locZ: -3404 };
const giranField = { locX: 76000, locY: 144000, locZ: -3600 };
const dionCenter = { locX: 15631, locY: 142885, locZ: -2704 };
const dionField = { locX: 23000, locY: 145000, locZ: -3100 };
const talkingIslandCenter = { locX: -84108, locY: 244604, locZ: -3729 };
const talkingIslandField = { locX: -80000, locY: 250000, locZ: -3500 };

assert.strictEqual(TownPathfinder.getTown(giranCenter).name, 'Giran');
assert.strictEqual(TownPathfinder.getTown(dionCenter).name, 'Dion');

const giranEntry = TownPathfinder.route(null, giranField, giranCenter);
assertNotSameLoc(giranEntry, giranCenter, 'Giran outside->inside should route through an entry/staging point');
assert.deepStrictEqual(
    giranEntry,
    TownGateCatalog.bestEntry('Giran', giranField, giranCenter).outside,
    'Giran entry should begin at the measured field side of a physical gate'
);

const giranExit = TownPathfinder.route(null, giranCenter, giranField);
assertNotSameLoc(giranExit, giranField, 'Giran inside->outside should route through an exit/staging point');
assert.deepStrictEqual(
    giranExit,
    TownGateCatalog.bestExit('Giran', giranCenter, giranField).inside,
    'Giran exit should begin at the measured town side of a physical gate'
);

const dionEntry = TownPathfinder.route(null, dionField, dionCenter);
assertNotSameLoc(dionEntry, dionCenter, 'Dion outside->inside should route through an entry/staging point');
assert(distance(dionEntry, dionCenter) < distance(dionField, dionCenter));

const gludinTown = BotAI.getClosestTown(-82000, 151000);
assert.strictEqual(gludinTown.name, 'Gludin');
assert.strictEqual(gludinTown.z, -3040);

const talkingIslandExitSteps = routeUntilTarget(talkingIslandCenter, talkingIslandField);
assert.deepStrictEqual(
    talkingIslandExitSteps[talkingIslandExitSteps.length - 1],
    talkingIslandField,
    'Talking Island inside->outside route should reach the field target instead of returning to the town center'
);
assert(talkingIslandExitSteps.length <= 5, 'Talking Island inside->outside route should not bounce between town waypoints');

const talkingIslandEntrySteps = routeUntilTarget(talkingIslandField, talkingIslandCenter);
assert.deepStrictEqual(
    talkingIslandEntrySteps[talkingIslandEntrySteps.length - 1],
    talkingIslandCenter,
    'Talking Island outside->inside route should reach the town target instead of bouncing between internal nodes'
);
assert(talkingIslandEntrySteps.length <= 6, 'Talking Island outside->inside route should not bounce between town waypoints');

const stickySession = {};
const shiftedTalkingIslandField = { locX: -79850, locY: 250120, locZ: -3500 };
const firstSticky = TownPathfinder.routeWithSession(stickySession, null, talkingIslandCenter, talkingIslandField);
const secondSticky = TownPathfinder.routeWithSession(stickySession, null, talkingIslandCenter, shiftedTalkingIslandField);
assert.deepStrictEqual(
    secondSticky.to,
    firstSticky.to,
    'sticky town route should keep the current waypoint while the final target only drifts slightly'
);
assert.strictEqual(secondSticky.diagnostics.reason, 'sticky_waypoint');

const westGiranShop = { locX: 80456, locY: 147864, locZ: -3504 };
const giranGatekeeper = { locX: 83396, locY: 148144, locZ: -3404 };
const variedActor = (id) => ({ fetchId: () => id });
const firstVaried = TownPathfinder.routeWithSession({}, variedActor(7101), westGiranShop, giranGatekeeper);
const secondVaried = TownPathfinder.routeWithSession({}, variedActor(7102), westGiranShop, giranGatekeeper);
assert.strictEqual(firstVaried.diagnostics.reason, 'new_waypoint_area');
assert.strictEqual(firstVaried.arrivalRadius, TownPathfinder.WAYPOINT_AREA_ARRIVAL_RADIUS);
assertNotSameLoc(firstVaried.to, firstVaried.diagnostics.plan.baseWaypoint,
    'a bot town segment should target a nearby area sample instead of the exact shared rail node');
assertNotSameLoc(firstVaried.to, secondVaried.to,
    'different bots should receive different stable samples inside the same waypoint area');
const repeatedVaried = TownPathfinder.routeWithSession(
    {},
    variedActor(7101),
    westGiranShop,
    giranGatekeeper
);
assert.deepStrictEqual(repeatedVaried.to, firstVaried.to,
    'the same bot and route should keep a stable area sample instead of jittering every tick');
const retryVaried = TownPathfinder.routeWithSession(
    { companionNavigationRecovery: { failures: 1 } },
    variedActor(7101),
    westGiranShop,
    giranGatekeeper
);
assertNotSameLoc(retryVaried.to, firstVaried.to,
    'a failed geodata attempt should rotate to another sample in the waypoint area');

const exactGateWithActor = TownPathfinder.routeWithSession({}, variedActor(7101), giranCenter, giranField);
assert.deepStrictEqual(
    exactGateWithActor.to,
    TownGateCatalog.bestExit('Giran', giranCenter, giranField).inside,
    'physical gate waypoints must remain exact instead of receiving bot variation'
);

const globalStart = { locX: 0, locY: 0, locZ: 0 };
const globalTarget = { locX: 6000, locY: 0, locZ: -300 };
const globalFirst = TownPathfinder.routeWithSession({}, variedActor(7201), globalStart, globalTarget);
const globalSecond = TownPathfinder.routeWithSession({}, variedActor(7202), globalStart, globalTarget);
assert.strictEqual(globalFirst.diagnostics.reason, 'new_waypoint_area');
assert.strictEqual(globalFirst.diagnostics.plan.progressive, true,
    'long routes outside the measured town polygons must still use bounded global segments');
assert(distance(globalStart, globalFirst.to) < 1500,
    'a global segment should cap the first geodata search near the actor');
assert(distance(globalFirst.to, globalTarget) < distance(globalStart, globalTarget),
    'a global segment must make forward progress toward the final target');
assertNotSameLoc(globalFirst.to, globalSecond.to,
    'global segmented routes should also vary by bot instead of forming rails');

// A walk between a spot and its town follows the spot's town way (TownWays): from Karul
// Bugbear fields (20_12) the straight line to Hunter's Village crosses a ridge no walk
// crosses; the way runs east and south round it. The fixture is the generator's output
// for 20_12 and 20_13 (scripts/generate-town-ways.js --spot-ids=20_12,20_13).
const TownWays = invoke('GameServer/Bot/Travel/TownWays');
const path = require('path');
TownWays.useFile(path.join(__dirname, 'fixtures', 'town-ways-karul.json'));
try {
    const way = TownWays.way('20_12');
    const onOut = (point) => way.out.some((p) => p.locX === point.locX && p.locY === point.locY && p.locZ === point.locZ);
    const center = { locX: 123948, locY: 75896, locZ: -2605 };
    const hally = { locX: 116646, locY: 74820, locZ: -2581, town: "Hunter's Village" };
    // bless1ng's field position (run B): the walk's first leg is a point of the way.
    const field = { locX: 123700, locY: 75953, locZ: -2464 };
    const errand = { currentSpot: { id: '20_12', center } };
    const first = TownPathfinder.routeWithSession(errand, variedActor(2001505), field, hally);
    assert(onOut(first.to), `the errand walk heads for its way, not the straight line (${JSON.stringify(first.to)})`);
    assert.strictEqual(first.diagnostics.reason, 'town_way');
    assert.strictEqual(first.diagnostics.townWay, '20_12');
    // Held on the way's leg before it is reached, the walk still names its way: a give-up there is traced.
    const held = TownPathfinder.routeWithSession(errand, variedActor(2001505), field, hally);
    assert.strictEqual(held.diagnostics.reason, 'sticky_waypoint');
    assert.strictEqual(held.diagnostics.townWay, '20_12', 'a held way leg names its way');
    // At that point the next leg is the way's next point (the sticky leg held until reached).
    const index = way.out.findIndex((p) => p.locX === first.to.locX && p.locY === first.to.locY);
    const second = TownPathfinder.routeWithSession(errand, variedActor(2001505), { ...first.to }, hally);
    assert.deepStrictEqual(second.to, { ...way.out[index + 1] }, 'a reached way point leads to the next');
    // The walk back from the town's square to the spot's centre follows the way back.
    const back = TownPathfinder.routeWithSession({ spotRelocation: { spotId: '20_12', destination: center } }, variedActor(2001505),
        { locX: 117129, locY: 76917, locZ: -2689 }, center);
    assert(way.back.some((p) => p.locX === back.to.locX && p.locY === back.to.locY), 'the walk back heads for its way');
    // No way: a spot without a row, or a target in another town, routes as before.
    const plain = TownPathfinder.routeWithSession({ currentSpot: { id: '99_99', center } }, variedActor(2001505), field, hally);
    assert.strictEqual(plain.diagnostics.reason, 'new_waypoint_area');
    assert(!onOut(plain.to));
    const elsewhere = TownPathfinder.routeWithSession({ currentSpot: { id: '20_12', center } }, variedActor(2001505), field,
        { locX: 146737, locY: 25807, locZ: -2008, town: 'Aden' });
    assert.strictEqual(elsewhere.diagnostics.reason, 'new_waypoint_area', 'a walk to another town keeps its straight leg');
} finally {
    TownWays.useFile();
}

console.log('TownPathfinder regression checks passed');
