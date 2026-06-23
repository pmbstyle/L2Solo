const assert = require('assert');

require('../src/Global');

const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
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
assert.strictEqual(TownPathfinder.getTown(giranEntry).name, 'Giran');

const giranExit = TownPathfinder.route(null, giranCenter, giranField);
assertNotSameLoc(giranExit, giranField, 'Giran inside->outside should route through an exit/staging point');
assert.strictEqual(TownPathfinder.getTown(giranExit).name, 'Giran');

const dionEntry = TownPathfinder.route(null, dionField, dionCenter);
assertNotSameLoc(dionEntry, dionCenter, 'Dion outside->inside should route through an entry/staging point');
assert(distance(dionEntry, dionCenter) < distance(dionField, dionCenter));

const gludinTown = BotAI.getClosestTown(-82000, 151000);
assert.strictEqual(gludinTown.name, 'Gludin');
assert.strictEqual(gludinTown.z, -3044);

const talkingIslandExitSteps = routeUntilTarget(talkingIslandCenter, talkingIslandField);
assert.deepStrictEqual(
    talkingIslandExitSteps[talkingIslandExitSteps.length - 1],
    talkingIslandField,
    'Talking Island inside->outside route should reach the field target instead of returning to the town center'
);
assert(talkingIslandExitSteps.length <= 3, 'Talking Island inside->outside route should not bounce between town waypoints');

const talkingIslandEntrySteps = routeUntilTarget(talkingIslandField, talkingIslandCenter);
assert.deepStrictEqual(
    talkingIslandEntrySteps[talkingIslandEntrySteps.length - 1],
    talkingIslandCenter,
    'Talking Island outside->inside route should reach the town target instead of bouncing between internal nodes'
);
assert(talkingIslandEntrySteps.length <= 3, 'Talking Island outside->inside route should not bounce between town waypoints');

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

console.log('TownPathfinder regression checks passed');
