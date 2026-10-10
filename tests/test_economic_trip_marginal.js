'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Trip = require('../src/GameServer/Bot/Population/ColdTrip');
const Profit = require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
const Towns = require('../src/GameServer/World/TownRespawn');
const saved = Config.coldHonestTravel;
function drain(iterator) { let next; do { next = iterator.next(); } while (!next.done); return next.value; }
try {
    Config.coldHonestTravel = true;
    const home = { locX: 20000, locY: 140000, locZ: -3000 };
    const dion = Trip.point(Towns.towns.dion_town), giran = Trip.point(Towns.towns.giran_town);
    const state = { characterId: 9301, phase: 'cold', activity: 'shopping', currentRegion: 'Dion', loc: dion,
        inventory: { 736: { selfId: 736, amount: 2 } }, stats: { marketReturn: { loc: home } } };
    const outward = Trip.townPlan(state, Towns.towns.giran_town);
    const baseline = Trip.spotTripMs(state, home);
    const returnMs = Trip.spotTripMs({ ...state, loc: giran }, home);
    const expectedHours = Math.max(0, outward.durationMs + returnMs - baseline) / 3600000;
    const reader = Profit.tripFor(state, { hourAdena: 1000 });
    assert.equal(reader.details('Giran').hours, expectedHours, 'already completed outbound is sunk; compare the additional detour to the remaining return');
    assert.equal(reader.details('Giran').fees, outward.route.fee);
    assert.equal(reader('Dion'), 0, 'an action in the current visit adds no journey');
    const EconomicTrip = require('../src/GameServer/Bot/Economy/EconomicTrip');
    assert.deepEqual(drain(EconomicTrip.details(state, 'Giran')), reader.details('Giran'), 'cooperative and synchronous readers share one result');
    const visiting = { ...state, stats: {} };
    assert.equal(EconomicTrip.read(visiting, 'Giran').hours, outward.durationMs / 3600000, 'staying in town does not invent a return');
    const planned = { ...state, activity: 'traveling', currentRegion: 'Field', loc: home,
        stats: { marketReturn: { loc: home }, travel: { townName: 'Dion', to: dion, arrivalActivity: 'shopping' } } };
    assert.equal(EconomicTrip.read(planned, 'Dion').hours, 0, 'an already accepted trip is shared');
    assert.equal(EconomicTrip.read({ ...state, loc: { locX: 0, locY: 0 }, stats: {} }, 'Giran').known, false);
    assert.equal(EconomicTrip.read({ ...state, stats: { karma: 700 } }, 'Giran').known, false);
    assert.equal(EconomicTrip.read(state, 'Unknown town').known, false);
    assert.strictEqual(Profit.tripFor(state, { hourAdena: 1000 }), reader, 'same owner inputs reuse one bounded route reader');
    state.loc = giran;
    assert.notStrictEqual(Profit.tripFor(state, { hourAdena: 1000 }), reader, 'changing current position invalidates the captured route');
    // A remembered region answers like the polygon walk and skips its edges.
    const walk = run => { let edges = 0, next; do { next = run.next(); if (next.value === 'edge') edges++; } while (!next.done); return [edges, next.value]; };
    const probe = { characterId: 9302, activity: 'idle', loc: { locX: 81234, locY: 147321, locZ: -3400 }, inventory: {}, stats: {} };
    const [coldEdges, cold] = walk(EconomicTrip.details(probe, 'Giran')), [warmEdges, warm] = walk(EconomicTrip.details(probe, 'Giran'));
    assert.deepEqual(warm, cold);
    assert.equal(cold.known, true);
    assert.ok(warmEdges < coldEdges, `remembered regions skip the walk (${warmEdges} < ${coldEdges})`);
    console.log('Economic marginal trips: spent outbound, shared visit, extra detour, actual continuation, worker parity and unknown/karma routes passed');
} finally { Config.coldHonestTravel = saved; }
