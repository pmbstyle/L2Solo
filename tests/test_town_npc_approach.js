const assert = require('assert');

require('../src/Global');

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const World = invoke('GameServer/World/World');
const TownNpcBodies = invoke('GameServer/Bot/AI/TownNpcBodies');
const InteractionGeometry = invoke('GameServer/Geodata/NpcInteractionGeometry');
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

function distance2d(a, b) { return Math.hypot(a.locX - b.locX, a.locY - b.locY); }

function identifiedBotAt(actorId, locX, locY, locZ = -100) {
    return {
        ...botAt(locX, locY, locZ),
        fetchId: () => actorId
    };
}

// Protocol/queue behavior should not depend on an installed terrain pack.
const originalGeo = Object.fromEntries(['hasGeo', 'canWalkStraight', 'getHeight', 'getCellData', 'checkVirtualObstacles']
    .map(key => [key, GeodataEngine[key]]));
GeodataEngine.hasGeo = () => false;
GeodataEngine.canWalkStraight = () => true;
GeodataEngine.getHeight = (x, y, z) => z;

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

{
    // The talking place: the actorId picks the start; a body on it sends the next bot on to the next place.
    const front = points.front;
    assert(front.length > 4, 'a counter front has room for several bodies');
    assert.deepStrictEqual(front[0], points.interaction, 'the first place is the base interaction point');
    const start = TownNpcApproach.talkPointFor(target, 0);
    assert.deepStrictEqual(start, front[0]);
    assert.deepStrictEqual(TownNpcApproach.talkPointFor(target, front.length * 7 + 2), front[2],
        'the actor id picks its start place');
    assert.deepStrictEqual(TownNpcApproach.talkPointFor(target, 0, [{ locX: start.locX + 5, locY: start.locY }]), front[1],
        'a body on the start place sends the next bot to the next place');
    assert.deepStrictEqual(TownNpcApproach.talkPointFor(target, 0, front.map(({ locX, locY }) => ({ locX, locY }))), front[0],
        'with every place taken the bot stands on its start place');
    assert.strictEqual(TownNpcApproach.talkPointFor({ ...target, head: null }, 0), null);
}

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

for (let index = 0; index < 32; index++) {
    const session = {};
    const approach = TownNpcApproach.plan(session, identifiedBotAt(2200000 + index, 4000, 4000), target, 'shopping');
    assert.deepStrictEqual([approach.phase, approach.destination.locX, approach.destination.locY],
        ['staging', points.staging.locX, points.staging.locY],
        'distant shoppers must walk to the shop street whatever their number');
    TownNpcApproach.reset(session);
}

{
    const gate = { ...target, npcSelfId: 7002 };
    const shoppers = Array.from({ length: 32 }, (_, index) => ({
        session: {}, bot: identifiedBotAt(2300000 + index, 4000, 4000)
    }));
    for (const { session, bot } of shoppers) {
        const approach = TownNpcApproach.planOpen(session, bot, gate, 'town_gatekeeper');
        assert(distance2d(approach.destination, gate) <= TownNpcApproach.INTERACTION_DISTANCE + 0.5,
            'all departing shoppers must walk to a place at the gatekeeper instead of queuing inside the shop');
        bot.locX = gate.locX + 200;
        bot.locY = gate.locY;
    }
    const arrivals = shoppers.map(({ session, bot }) => TownNpcApproach.planOpen(session, bot, gate, 'town_gatekeeper'));
    assert(arrivals.every(approach => !approach.ready && distance2d(approach.destination, gate) <= TownNpcApproach.INTERACTION_DISTANCE + 0.5),
        'every arrival 200 from the gatekeeper keeps walking to its own place: nobody is held back or ready early');
    shoppers.forEach(({ session }) => TownNpcApproach.reset(session));
}

{
    const session = { shoppingDoneAnnounced: true, townNpcApproach: { key: 'finished-shopping', phase: 'interaction' } };
    invoke('GameServer/Bot/AI/States/ShoppingState').tick(session, {}, {}, {});
    assert(!session.townNpcApproach,
        'a completed shopper awaiting its return callback must not keep an approach to the counter');
}

{
    const edgeTarget = { ...target, npcSelfId: 7003 };
    const edgePoints = TownNpcApproach.pointsFor(edgeTarget);
    const edge = botAt(edgePoints.interaction.locX + 8, edgePoints.interaction.locY);
    GeodataEngine.canWalkStraight = (x, y) => x !== edge.locX || y !== edge.locY;
    assert(!TownNpcApproach.hasLineOfSight(edge, edgeTarget));
    assert(TownNpcApproach.plan({}, edge, edgeTarget, 'shopping').ready,
        'a clipped arrival cell within 16 units of a visible counter point may complete interaction');
    edge.locX += 16;
    assert(!TownNpcApproach.plan({}, edge, edgeTarget, 'shopping').ready,
        'a clipped arrival cell beyond the tight counter allowance must require visibility');
}

{
    const from = { locX: 0, locY: 0, locZ: 0 };
    const to = { locX: 72, locY: 0, locZ: 0 };
    let obstacleHeight = 24, virtualWall = false;
    const originalVisibility = InteractionGeometry.canSee;
    InteractionGeometry.canSee = () => true;
    GeodataEngine.hasGeo = () => true;
    GeodataEngine.canWalkStraight = () => false;
    GeodataEngine.getCellData = x => ({ z: x >= 32 && x <= 40 ? obstacleHeight : 0, nswe: 0 });
    GeodataEngine.checkVirtualObstacles = () => virtualWall;
    assert(TownNpcApproach.hasInteractionLineOfSight(from, to),
        'conversation can cross a low counter that blocks walking');
    assert(!TownNpcApproach.hasLineOfSight(from, to), 'a visible counter must still block walking');
    obstacleHeight = 128;
    assert(!TownNpcApproach.hasInteractionLineOfSight(from, to), 'a full wall must block conversation');
    obstacleHeight = 24;
    virtualWall = true;
    assert(!TownNpcApproach.hasInteractionLineOfSight(from, to), 'virtual walls must remain opaque');
    virtualWall = false;
    assert(!TownNpcApproach.hasInteractionLineOfSight(from, { ...to, locZ: 200 }),
        'conversation must not cross floors');
    assert(!TownNpcApproach.hasInteractionLineOfSight(from, { ...to, locZ: 64 }),
        'nearby stacked floors must not bypass the walking layer check');
    InteractionGeometry.canSee = () => false;
    assert(!TownNpcApproach.hasInteractionLineOfSight(from, to), 'NSWE blocks remain opaque without verified collision geometry');
    InteractionGeometry.canSee = originalVisibility;
    GeodataEngine.hasGeo = () => false;
    assert(!TownNpcApproach.hasInteractionLineOfSight(from, to),
        'missing geodata must not bypass a rejected walking segment');
}
Object.assign(GeodataEngine, originalGeo);

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
    assert(TownNpcApproach.hasInteractionLineOfSight(helvetiaPoints.interaction, helvetia),
        'the chosen counter point must see Helvetia on the installed client geometry');
    assert(Math.abs(GeodataEngine.getHeight(helvetiaPoints.staging.locX, helvetiaPoints.staging.locY,
        helvetiaPoints.staging.locZ) - helvetiaPoints.staging.locZ) <= 64);

    for (const fixture of [
        { id: 2002921, locY: 147688, npc: helvetia },
        { id: 2003604, locY: 148040, npc: { ...helvetia, actorId: 1002, npcSelfId: 7082, name: 'Denkus', locY: 147873 } }
    ]) {
        // Reproduce the two live stuck actors, then cover every slot choice.
        for (let offset = 0; offset < 10; offset++) {
            const bot = identifiedBotAt(fixture.id + offset, 80328, fixture.locY, -3504);
            const session = {};
            TownNpcApproach.plan(session, bot, fixture.npc, 'shopping');
            TownNpcApproach.skipStaging(session);
            const approach = TownNpcApproach.plan(session, bot, fixture.npc, 'shopping');
            const target = approach.destination;
            const path = GeodataEngine.findPath(bot.locX, bot.locY, bot.locZ, target.locX, target.locY, target.locZ,
                5000, { debug: false, goalRadius: approach.arrivalRadius, goalZTolerance: 64 });
            assert(path?.length, `${fixture.npc.name} slot ${offset} must be reachable from the actual street position`);
            Object.assign(bot, path.at(-1));
            assert(TownNpcApproach.plan(session, bot, fixture.npc, 'shopping').ready,
                `the reachable ${fixture.npc.name} slot ${offset} endpoint ${JSON.stringify(bot)} must complete interaction without crossing the counter`);
            TownNpcApproach.reset(session);
        }
    }

    const shoppers = Array.from({ length: 32 }, (_, index) => ({
        session: {}, bot: identifiedBotAt(2100000 + index, 84119, 147791, -3400)
    }));
    for (const { session, bot } of shoppers) {
        const approach = TownNpcApproach.plan(session, bot, helvetia, 'shopping');
        assert.deepStrictEqual([approach.phase, approach.destination.locX, approach.destination.locY],
            ['staging', helvetiaPoints.staging.locX, helvetiaPoints.staging.locY],
            'all 32 distant shoppers must start walking to the street instead of waiting across town');
        Object.assign(bot, helvetiaPoints.staging);
    }
    // Bodies stand where earlier shoppers stopped, as World reports them.
    const standing = [];
    const sessionsNear = World.actorSessionsNear;
    World.actorSessionsNear = () => standing.map(actor => ({ actor }));
    try {
        const arrivals = [];
        for (const { session, bot } of shoppers) {
            const approach = TownNpcApproach.plan(session, bot, helvetia, 'shopping', { bodiesNear: TownNpcBodies.seenBy(bot) });
            const destination = approach.destination;
            assert(helvetiaPoints.front.some(place => place.locX === destination.locX && place.locY === destination.locY),
                'each shopper is sent to a place of the counter front');
            const path = GeodataEngine.findPath(bot.locX, bot.locY, bot.locZ,
                destination.locX, destination.locY, destination.locZ, 5000,
                { debug: false, goalRadius: approach.arrivalRadius, goalZTolerance: 64 });
            assert(path?.length, 'each shopper receives a reachable counter point');
            Object.assign(bot, path.at(-1));
            assert(TownNpcApproach.plan(session, bot, helvetia, 'shopping', { bodiesNear: TownNpcBodies.seenBy(bot) }).ready,
                'each shopper can talk from where it stopped');
            standing.push(bot);
            arrivals.push(destination);
        }
        assert(new Set(arrivals.map(row => `${row.locX}:${row.locY}`)).size > 5,
            'the shoppers spread over the counter front instead of the five old places');
    } finally { World.actorSessionsNear = sessionsNear; }
});

verifyGeodataWhenAvailable(GeodataEngine, [[17, 25]], 'Silvia counter, several shoppers at once', () => {
    const silvia = { actorId: 7003, npcSelfId: 7003, name: 'Silvia', town: 'Talking Island',
        locX: -83789, locY: 240799, locZ: -3717, head: 32768 };
    const base = TownNpcApproach.pointsFor(silvia);
    const standing = [];
    const sessionsNear = World.actorSessionsNear;
    World.actorSessionsNear = () => standing.map(actor => ({ actor }));
    const apart = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
    // One shopper from the staging point to its end of the walk, left standing there as its body.
    const arrive = (id) => {
        const bot = identifiedBotAt(id, base.staging.locX, base.staging.locY, base.staging.locZ);
        const session = {};
        const approach = TownNpcApproach.plan(session, bot, silvia, 'shopping', { bodiesNear: TownNpcBodies.seenBy(bot) });
        assert(base.front.some(place => place.locX === approach.destination.locX && place.locY === approach.destination.locY),
            `shopper ${id} is sent to a place of the counter front`);
        assert(Math.abs(GeodataEngine.getHeight(approach.destination.locX, approach.destination.locY, silvia.locZ)
            - silvia.locZ) <= 64, `shopper ${id}'s place is on Silvia's floor`);
        const path = GeodataEngine.findPath(bot.locX, bot.locY, bot.locZ, approach.destination.locX,
            approach.destination.locY, approach.destination.locZ, 5000, { goalRadius: approach.arrivalRadius, goalZTolerance: 64 });
        assert(path?.length, `shopper ${id}'s place is reachable from the staging point`);
        Object.assign(bot, path.at(-1));
        standing.push(bot);
        return { id, bot, session, destination: approach.destination };
    };
    try {
        // The reported pair: the first shopper's body stays on its place while the buy runs.
        const first = arrive(2000510);
        assert(TownNpcApproach.plan(first.session, first.bot, silvia, 'shopping', { bodiesNear: TownNpcBodies.seenBy(first.bot) }).ready);
        TownNpcApproach.reset(first.session);
        const second = arrive(2000995);
        assert(apart(second.destination, first.bot) >= 16,
            'a second shopper must not walk onto the body of a shopper still at the counter');
        standing.length = 0;

        // Eight shoppers one after another, each body staying: no two stand on one point, all talk at once.
        const shoppers = [2000510, 2000995, 2000511, 2000512, 2000513, 2000514, 2000515, 2000516].map(arrive);
        for (let i = 0; i < shoppers.length; i++) for (let j = i + 1; j < i + shoppers.length && j < shoppers.length; j++) {
            assert(apart(shoppers[i].bot, shoppers[j].bot) >= 16,
                `shoppers ${shoppers[i].id} and ${shoppers[j].id} stand on one point at the counter`);
            assert(shoppers[i].destination.locX !== shoppers[j].destination.locX
                || shoppers[i].destination.locY !== shoppers[j].destination.locY, 'destinations differ');
        }
        for (const { session, bot } of shoppers) {
            assert(TownNpcApproach.plan(session, bot, silvia, 'shopping', { bodiesNear: TownNpcBodies.seenBy(bot) }).ready, 'every shopper talks from its own place');
        }
        standing.length = 0;

        // Two ids that start on one place: the later one moves on to the next free place.
        const front = base.front;
        const early = arrive(2000510), late = arrive(2000510 + front.length);
        assert(apart(early.bot, late.bot) >= 16, 'ids starting on one place do not stack bodies');
        standing.length = 0;

        // Two ids on one start place pick in the same moment (neither sees a body) and both walk there: on
        // arrival the higher id picks again, the lower keeps its place, and the two end apart.
        {
            const lowId = 2000510, highId = 2000510 + front.length;
            const pair = [lowId, highId].map(id => {
                const bot = identifiedBotAt(id, base.staging.locX, base.staging.locY, base.staging.locZ);
                const session = {};
                const approach = TownNpcApproach.plan(session, bot, silvia, 'shopping');
                return { id, bot, session, approach };
            });
            assert.deepStrictEqual(pair[0].approach.destination, pair[1].approach.destination, 'the same moment picks one place');
            for (const one of pair) {
                const to = one.approach.destination;
                const path = GeodataEngine.findPath(one.bot.locX, one.bot.locY, one.bot.locZ, to.locX, to.locY, to.locZ,
                    5000, { goalRadius: one.approach.arrivalRadius, goalZTolerance: 64 });
                Object.assign(one.bot, path.at(-1));
                standing.push(one.bot);
            }
            const [low, high] = pair;
            const lowPlan = TownNpcApproach.plan(low.session, low.bot, silvia, 'shopping', { bodiesNear: TownNpcBodies.seenBy(low.bot) });
            const highPlan = TownNpcApproach.plan(high.session, high.bot, silvia, 'shopping', { bodiesNear: TownNpcBodies.seenBy(high.bot) });
            assert.deepStrictEqual(lowPlan.destination, low.approach.destination, 'the lower id keeps its place');
            assert.notDeepStrictEqual(highPlan.destination, high.approach.destination, 'the higher id picks another place');
            const path = GeodataEngine.findPath(high.bot.locX, high.bot.locY, high.bot.locZ, highPlan.destination.locX,
                highPlan.destination.locY, highPlan.destination.locZ, 5000, { goalRadius: highPlan.arrivalRadius, goalZTolerance: 64 });
            Object.assign(high.bot, path.at(-1));
            assert(apart(low.bot, high.bot) >= 16, 'after arrival the two bots stand apart');
            for (const one of pair) assert(TownNpcApproach.plan(one.session, one.bot, silvia, 'shopping',
                { bodiesNear: TownNpcBodies.seenBy(one.bot) }).ready, 'both talk from their places');
            standing.length = 0;
        }

        // Hot = cold: with no bodies near, the destination is the pure pick the clan hall travel uses.
        for (const id of [2000510, 2000995, 2000511]) {
            const bot = identifiedBotAt(id, base.interaction.locX, base.interaction.locY, base.interaction.locZ);
            bot.locX = base.staging.locX; bot.locY = base.staging.locY; bot.locZ = base.staging.locZ;
            const approach = TownNpcApproach.plan({}, bot, silvia, 'shopping');
            assert.strictEqual(approach.phase, 'interaction');
            const own = TownNpcApproach.talkPointFor(silvia, id);
            assert.deepStrictEqual([approach.destination.locX, approach.destination.locY], [own.locX, own.locY],
                `shopper ${id}'s hot destination is the pure pick`);
        }
    } finally { World.actorSessionsNear = sessionsNear; }
});

verifyGeodataWhenAvailable(GeodataEngine, [[17, 25]], 'Talking Island gatekeeper, eight bots one after another', () => {
    const gatekeeper = { actorId: 7006, npcSelfId: 7006, name: 'Gatekeeper', town: 'Talking Island',
        locX: -84108, locY: 244604, locZ: -3729, head: 0 };
    gatekeeper.locZ = GeodataEngine.getHeight(gatekeeper.locX, gatekeeper.locY, gatekeeper.locZ);
    const standing = [];
    const sessionsNear = World.actorSessionsNear;
    World.actorSessionsNear = () => standing.map(actor => ({ actor }));
    try {
        const bots = [];
        for (let i = 0; i < 8; i++) {
            const angle = (i - 3.5) * Math.PI / 60;
            const x = Math.round(gatekeeper.locX + Math.cos(angle) * 600), y = Math.round(gatekeeper.locY + Math.sin(angle) * 600);
            const bot = identifiedBotAt(2000510 + i, x, y, GeodataEngine.getHeight(x, y, gatekeeper.locZ));
            const session = {};
            const options = { bodiesNear: TownNpcBodies.seenBy(bot) };
            let approach = TownNpcApproach.planOpen(session, bot, gatekeeper, 'town_gatekeeper', options);
            Object.assign(bot, approach.destination);
            approach = TownNpcApproach.planOpen(session, bot, gatekeeper, 'town_gatekeeper', options);
            Object.assign(bot, approach.destination);
            standing.push(bot);
            bots.push({ bot, session, options });
        }
        for (let i = 0; i < bots.length; i++) {
            assert(TownNpcApproach.planOpen(bots[i].session, bots[i].bot, gatekeeper, 'town_gatekeeper', bots[i].options).ready,
                `bot ${i} talks to the gatekeeper from where it stands`);
            for (let j = i + 1; j < bots.length; j++) assert(distance2d(bots[i].bot, bots[j].bot) >= 16,
                `bots ${i} and ${j} stand on one point at the gatekeeper`);
        }
    } finally { World.actorSessionsNear = sessionsNear; }
});

verifyGeodataWhenAvailable(GeodataEngine, [[20, 22]], 'Dion side front point, service without the bot own point', () => {
    const npc = { npcSelfId: 7060, locX: 17999, locY: 144484, locZ: -3046, head: 6000 };
    const front = TownNpcApproach.pointsFor(npc).front;
    const bot = identifiedBotAt(1, 18088, 144536, -3048);
    assert(front.some(place => distance2d(bot, place) <= TownNpcApproach.INTERACTION_ARRIVAL_RADIUS),
        'the bot stands on a side place of the counter front');
    assert(TownNpcApproach.canInteract(bot, npc), 'a service at a side place is not refused');
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

// One rule for talking to an NPC (T49 review): an NPC seen only across a low counter is in reach for the hot
// improvement check and the clan hall managers too, not only for plan().
{
    const npc = { ...botAt(72, 0, 0), fetchSelfId: () => 7097, fetchHead: () => 32768 };
    GeodataEngine.hasGeo = () => true;
    GeodataEngine.canWalkStraight = () => false;
    GeodataEngine.getCellData = x => ({ z: x >= 32 && x <= 40 ? 24 : 0, nswe: 0 });
    GeodataEngine.checkVirtualObstacles = () => false;
    const clientSight = InteractionGeometry.canSee;
    InteractionGeometry.canSee = () => true;
    assert(TownNpcApproach.canInteract({ locX: 0, locY: 0, locZ: 0 }, TownNpcApproach.npcTarget(npc)),
        'an NPC behind a low counter can be talked to');
    assert(invoke('GameServer/ClanHall/Services').near(botAt(0, 0, 0), npc),
        'a clan hall manager behind a low counter is near');
    InteractionGeometry.canSee = clientSight;
    Object.assign(GeodataEngine, originalGeo);
}

verifyGeodataWhenAvailable(GeodataEngine, [[22, 22]], 'Giran luxury exchange counter', () => {
    const galladucci = TownNpcApproach.npcTarget({ ...botAt(79599, 145522, -3494), fetchSelfId: () => 7097, fetchHead: () => 0 });
    // The point plan() walks to (pointsFor): the bot can talk from there under the client geometry.
    const interaction = TownNpcApproach.pointsFor(galladucci).interaction;
    assert(TownNpcApproach.canInteract(interaction, galladucci), 'Galladucci is in reach from his interaction point');
});

// An approach point stands on the NPC's floor: beside the Rune gatekeeper and the Elven Village warehouse counters a
// radial point over a pillar or platform top is skipped, so bots are never sent to a point they cannot walk to.
verifyGeodataWhenAvailable(GeodataEngine, [[21, 18], [21, 19]], 'Rune gatekeeper and Elven warehouse approach floors', () => {
    const gatekeeper = { npcSelfId: 8320, locX: 43824, locY: -47664, locZ: -792, head: 0 };
    for (let k = 2; k <= 5; k++) {
        const angle = k * Math.PI / 8;
        const bx = Math.round(gatekeeper.locX + Math.cos(angle) * 600), by = Math.round(gatekeeper.locY + Math.sin(angle) * 600);
        const bz = GeodataEngine.getHeight(bx, by, gatekeeper.locZ);
        const bot = { fetchId: () => 1000 + k, fetchLocX: () => bx, fetchLocY: () => by, fetchLocZ: () => bz };
        const goal = TownNpcApproach.planOpen(null, bot, gatekeeper, 'town_gatekeeper').destination;
        assert(Math.abs(GeodataEngine.getHeight(goal.locX, goal.locY, goal.locZ) - gatekeeper.locZ) <= 64,
            `a bot coming from direction ${k} is sent to the Rune gatekeeper's floor`);
        assert(GeodataEngine.findPath(gatekeeper.locX, gatekeeper.locY, gatekeeper.locZ, goal.locX, goal.locY, goal.locZ, 2000, { goalRadius: 16 }),
            `the Rune gatekeeper's approach point from direction ${k} is joined to the NPC by a route`);
    }
    for (const [npcSelfId, locX, locY] of [[7151, 47868, 50167], [7152, 47912, 50170]]) {
        const warehouse = { npcSelfId, locX, locY, locZ: -2983, head: 50000 };
        const point = TownNpcApproach.pointsFor(warehouse).interaction;
        assert(Math.abs(GeodataEngine.getHeight(point.locX, point.locY, warehouse.locZ) - warehouse.locZ) <= 64,
            `the counter point of Elven warehouse ${npcSelfId} is on the NPC's floor`);
    }
});

console.log('Town NPC front-side approach checks passed');
