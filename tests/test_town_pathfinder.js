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

const giranCenter = { locX: 83396, locY: 147904, locZ: -3404 };
const giranField = { locX: 76000, locY: 144000, locZ: -3600 };
const dionCenter = { locX: 15631, locY: 142885, locZ: -2704 };
const dionField = { locX: 23000, locY: 145000, locZ: -3100 };

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

console.log('TownPathfinder regression checks passed');
