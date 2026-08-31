const assert = require('assert');

require('../src/Global');

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');

function botAt(locX, locY, locZ = -100) {
    return {
        locX,
        locY,
        locZ,
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; }
    };
}

function identifiedBotAt(actorId, locX, locY, locZ = -100) {
    return {
        ...botAt(locX, locY, locZ),
        fetchId: () => actorId
    };
}

const target = {
    actorId: 101,
    npcSelfId: 7001,
    name: 'Door Probe',
    town: 'Talking Island',
    locX: 1000,
    locY: 1000,
    locZ: -100,
    head: 0
};

const points = TownNpcApproach.pointsFor(target);
assert.deepStrictEqual(points.staging, { locX: 1240, locY: 1000, locZ: -100 });
assert.deepStrictEqual(points.interaction, { locX: 1072, locY: 1000, locZ: -100 });

const session = {};
const behind = botAt(824, 1000);
let approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.ready, false,
    'being inside ordinary NPC range behind the shopkeeper must not permit through-wall trade');
assert.strictEqual(approach.phase, 'staging');
assert.deepStrictEqual(
    { locX: approach.destination.locX, locY: approach.destination.locY, locZ: approach.destination.locZ },
    points.staging
);

behind.locX = points.staging.locX;
approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.phase, 'interaction', 'reaching the street waypoint must open the final approach');
assert.strictEqual(approach.ready, false);
assert.strictEqual(approach.arrivalRadius, TownNpcApproach.INTERACTION_ARRIVAL_RADIUS);

behind.locX = points.interaction.locX;
approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.ready, true, 'the front-side interaction point must permit the town errand');

behind.locX = points.interaction.locX + TownNpcApproach.INTERACTION_READY_RADIUS;
approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.ready, true,
    'a bot should interact from the modestly expanded front-side tolerance');

behind.locX += 1;
approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.ready, false,
    'the expanded tolerance must remain bounded near the interaction point');

const northFacing = TownNpcApproach.pointsFor({ ...target, head: 16384 });
assert.deepStrictEqual(northFacing.staging, { locX: 1000, locY: 1240, locZ: -100 },
    'Lineage heading units must project consistently onto world coordinates');
assert.strictEqual(TownNpcApproach.pointsFor({ ...target, head: null }), null,
    'targets without heading data must retain the legacy radius behavior');

verifyGeodataWhenAvailable(GeodataEngine, [[22, 22]], 'Giran Helvetia counter approach', () => {
    const helvetia = {
        actorId: 1001,
        npcSelfId: 7081,
        name: 'Helvetia',
        town: 'Giran',
        locX: 80518,
        locY: 147922,
        locZ: -3506,
        head: 32768
    };
    const helvetiaPoints = TownNpcApproach.pointsFor(helvetia);
    assert.deepStrictEqual(helvetiaPoints.interaction, { locX: 80467, locY: 147871, locZ: -3506 });
    const reachableCounterEdge = botAt(80456, 147864, -3504);
    assert.strictEqual(TownNpcApproach.hasLineOfSight(reachableCounterEdge, helvetia), false,
        'the last reachable Helvetia geodata cell should reproduce the live counter-edge LOS clip');
    assert.strictEqual(TownNpcApproach.plan({}, reachableCounterEdge, helvetia, 'shopping').ready, true,
        'reaching the tight edge of a validated counter point must permit interaction');
    const outsideCounterEdge = botAt(80448, 147864, -3504);
    assert.strictEqual(TownNpcApproach.hasLineOfSight(outsideCounterEdge, helvetia), false);
    assert.strictEqual(TownNpcApproach.plan({}, outsideCounterEdge, helvetia, 'shopping').ready, false,
        'a bot beyond the tight counter-edge allowance must still need direct line of sight');
});

const firstOpenSession = {};
const secondOpenSession = {};
const firstOpen = TownNpcApproach.planOpen(
    firstOpenSession,
    identifiedBotAt(101, 500, 1000),
    target,
    'newbie_guide'
);
const secondOpen = TownNpcApproach.planOpen(
    secondOpenSession,
    identifiedBotAt(102, 500, 1000),
    target,
    'newbie_guide'
);
assert.strictEqual(firstOpen.phase, 'interaction',
    'an open-air NPC must skip the shop-door staging phase');
assert.notDeepStrictEqual(firstOpen.destination, secondOpen.destination,
    'nearby hot bots must not funnel through one shared open-air approach point');
assert(Math.hypot(firstOpen.destination.locX - target.locX, firstOpen.destination.locY - target.locY) <= TownNpcApproach.INTERACTION_DISTANCE + 1,
    'the open-air approach should finish close to the NPC');

const alreadyClose = TownNpcApproach.planOpen(
    {},
    identifiedBotAt(103, target.locX + 80, target.locY),
    target,
    'newbie_guide'
);
assert.strictEqual(alreadyClose.ready, true,
    'a bot already close with line of sight must interact without walking out to a staging point');

const openBoundaryBot = identifiedBotAt(
    104,
    target.locX + TownNpcApproach.OPEN_INTERACTION_READY_RADIUS,
    target.locY
);
const openBoundary = TownNpcApproach.planOpen({}, openBoundaryBot, target, 'newbie_guide');
assert.strictEqual(openBoundary.ready, true,
    'open-air NPC interaction should accept the expanded nearby radius');

openBoundaryBot.locX += 1;
const outsideOpenBoundary = TownNpcApproach.planOpen({}, openBoundaryBot, target, 'newbie_guide');
assert.strictEqual(outsideOpenBoundary.ready, false,
    'open-air interaction must still reject bots just outside the nearby radius');

console.log('Town NPC front-side approach checks passed');
