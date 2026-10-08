const assert = require('assert');

require('../src/Global');

// The gatekeeper network table (TravelRoutes): built once from the C4
// teleport lists, the fee and hops between towns as a player pays them.
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const TravelRoutes = invoke('GameServer/Bot/Travel/TravelRoutes');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const LateTownGatekeepers = invoke('GameServer/World/C4LateTownGatekeepers');

// Every listed city gatekeeper stands in its town (spawn data).
const spawns = [...DataCache.npcSpawns, ...LateTownGatekeepers.spawns];
for (const [npcId, townKey] of Object.entries(TravelRoutes.GATEKEEPER_TOWNS)) {
    const coords = spawns.flatMap((zone) => zone.spawns || [])
        .filter((spawn) => Number(spawn.selfId) === Number(npcId)).flatMap((spawn) => spawn.coords || []);
    assert.ok(coords.length > 0, `gatekeeper ${npcId} has a spawn`);
    const town = TownRespawn.towns[townKey];
    assert.ok(coords.some((point) => Math.hypot(point.locX - town.locX, point.locY - town.locY) < 1000),
        `gatekeeper ${npcId} stands in ${town.name}`);
}

const route = (from, to) => TravelRoutes.route(from, to);
assert.deepStrictEqual(route('dion_town', 'dion_town'), { fee: 0, hops: 0 }, 'a trip inside one town is free');
assert.deepStrictEqual(route('dion_town', 'giran_town'), { fee: 8100, hops: 1 }, 'Dion to Giran: one hop at the C4 price');
assert.deepStrictEqual(route('giran_town', 'dion_town'), { fee: 8100, hops: 1 }, 'Giran to Dion: one hop');
assert.deepStrictEqual(route('dion_town', 'elven_village'), { fee: 7800, hops: 2 }, 'Dion to the Elven Village through Gludio');
assert.deepStrictEqual(route('ti_village', 'giran_town'), { fee: 33100, hops: 4 }, 'Talking Island to Giran: four paid hops');
assert.deepStrictEqual(route('innadril_town', 'giran_town'), { fee: 9200, hops: 1 }, 'Heine to Giran: one hop');
assert.strictEqual(route('dion_town', 'floran_village'), null, 'no gatekeeper leads to Floran (C4)');
assert.strictEqual(route('floran_village', 'dion_town'), null, 'Floran has no gatekeeper (C4)');

// A Scroll of Escape lands in the region's restart town: Floran's cell at Dion.
assert.strictEqual(TravelRoutes.landingTown({ locX: 17144, locY: 170156, locZ: -3504 }).name, 'Dion');
assert.strictEqual(TravelRoutes.landingTown({ locX: 22000, locY: 140000, locZ: -3000 }).name, 'Dion');
const trip = TravelRoutes.between({ locX: 22000, locY: 140000, locZ: -3000 }, { locX: 83396, locY: 147904, locZ: -3404 });
assert.strictEqual(trip.start.name, 'Dion');
assert.strictEqual(trip.destination.name, 'Giran');
assert.deepStrictEqual(trip.route, { fee: 8100, hops: 1 });
const toFloran = TravelRoutes.between({ locX: 83000, locY: 140000, locZ: -3400 }, { locX: 17144, locY: 170156, locZ: -3504 });
assert.strictEqual(toFloran.destination.name, 'Floran Village');
assert.strictEqual(toFloran.gate.name, 'Dion', 'Floran is walked to from Dion\'s gatekeeper');
assert.deepStrictEqual(toFloran.route, { fee: 8100, hops: 1 }, 'Giran to Floran pays the hop to Dion');

// Teleport points: each town and each gatekeeper destination, with the hops from a town.
const points = TravelRoutes.teleportPoints();
assert.ok(points.length > 80 && points.length < 120, `teleport points: ${points.length}`);
const dragonValley = points.find((point) => point.locX === 122881 && point.locY === 110792);
assert.strictEqual(dragonValley.hops.giran_town, 1, 'Giran reaches Dragon Valley in one hop');
assert.strictEqual(dragonValley.hops.dion_town, 2, 'Dion reaches Dragon Valley through Giran');
assert.strictEqual(TravelRoutes.teleportPoints(), points, 'the table is built once');

console.log('travel route table checks passed');
process.exit(0);

for (const [from,to] of [['dion_town','giran_town'],['ti_village','giran_town']]) {
    const selected = route(from,to);
    assert.equal(selected.steps.length, selected.hops);
    assert.equal(selected.steps.reduce((sum,step) => sum+step.fee,0),selected.fee);
    for (const step of selected.steps) assert.deepEqual(LateTownGatekeepers && invoke('GameServer/World/C4GatekeeperTeleports').destination(step.npcId,step.destinationId),
        {locX:step.locX,locY:step.locY,locZ:step.locZ,price:step.fee});
}
