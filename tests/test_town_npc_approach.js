const assert = require('assert');

require('../src/Global');

const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');

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

const northFacing = TownNpcApproach.pointsFor({ ...target, head: 16384 });
assert.deepStrictEqual(northFacing.staging, { locX: 1000, locY: 1240, locZ: -100 },
    'Lineage heading units must project consistently onto world coordinates');
assert.strictEqual(TownNpcApproach.pointsFor({ ...target, head: null }), null,
    'targets without heading data must retain the legacy radius behavior');

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

console.log('Town NPC front-side approach checks passed');
