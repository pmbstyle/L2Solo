'use strict';
const assert = require('node:assert/strict');
const { EconomyRouteCache } = require('../src/GameServer/Bot/Economy/EconomyRouteCache');
const sent = [], ready = [];
const cache = new EconomyRouteCache({ send: payload => { sent.push(payload); return true; },
    prepared: (id, key) => ready.push([id, key]), limit: 2 });
const frame = { activity: 'hunting' };
assert.equal(cache.read(1, 'old', frame), null);
for (let i = 0; i < 100; i++) cache.read(1, 'old', frame);
assert.equal(sent.length, 1, 'same pending input sends one request');
cache.read(1, 'new', frame);
const rows = Array.from({ length: 16 }, () => [true, 1, 2]);
assert.equal(cache.accept({ ...sent[0], rows }), false, 'old request cannot replace newer route');
assert.equal(cache.accept({ ...sent[1], rows }), true);
assert.equal(cache.accept({ ...sent[1], rows }), false, 'duplicate preparation starts no second event');
assert.strictEqual(cache.read(1, 'new', frame), rows);
assert.deepEqual(ready, [[1, 'new']]);
cache.read(2, 'pending', frame); cache.read(3, 'pending', frame);
assert.equal(cache.cards.has(1), false, 'completed cards can be evicted');
assert.equal(cache.cards.size, 2);
const count = sent.length; cache.read(4, 'pending', frame);
assert.equal(sent.length, count, 'capacity defers without allocating queued owner copies');
cache.forget(2); assert.equal(cache.accept({ ...sent[2], rows }), false);
cache.read(4, 'pending', frame); cache.clear();
assert.equal(cache.accept({ ...sent.at(-1), rows }), false, 'worker exit/removal invalidates old preparation');
const failed = new EconomyRouteCache({ send: () => false }); failed.read(1, 'offline', frame);
assert.equal(failed.cards.size, 0, 'unavailable worker retains no pending card');

require('./helpers/databaseIsolation');
require('../src/Global');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Trip = require('../src/GameServer/Bot/Economy/EconomicTrip');
const Events = require('../src/GameServer/Bot/AI/DecisionEvents');
const Party = require('../src/GameServer/Bot/Population/PartyGoalPolicy');
const base = { characterId: 1, activity: 'hunting', currentRegion: 'Giran', spotId: 'same',
    inventory: {}, loc: { locX: 80000, locY: 148000, locZ: -3500 }, stats: { decisionSeq: 10 } };
const session = { coldLifeState: { stats: { decisionSeq: 10, activityLeaf: 123 } } };
const first = Economy.routeState(base, session);
const walking = Economy.routeState({ ...base, loc: { ...base.loc, locX: 81000 } }, session);
assert.equal(Trip.key(first), Trip.key(walking), 'walking within held event preserves location anchor');
const arrived = Economy.routeState({ ...base, activity: 'shopping', currentRegion: 'Dion' }, session);
assert.notEqual(Economy.inputKey(first), Economy.inputKey(arrived), 'arrival invalidates economic input cache');
assert.notEqual(Economy.inputKey(first), Economy.inputKey({ ...first, inventory: { 736: { amount: 1 } } }));
assert.notEqual(Economy.inputKey(first), Economy.inputKey({ ...first, stats: { ...first.stats,
    marketReturn: { loc: { ...first.loc, locX: 70000 } } } }));
const objective = { spotId: 'held', objectiveKey: 'same', status: 'open' };
const joint = Party.joint({ stats: { objective } }, [base], { context: { routePending: true,
    network: { activity: { activity: 'hunting', spotId: 'different' } }, statsPacket: { wishFocus: ['new'] } } });
assert.strictEqual(joint.objective, objective);
assert.equal(joint.wishFocus, undefined, 'route wait does not install a new group roll or objective');
const previous = { network: { activity: { activity: 'hunting' } } };
session.heldEconomy = previous; session.economySeq = 10;
// A real economy context always carries its stock reader (0175fd23), pending route or not.
const pending = { stock: () => ({ itemId: 0, usePerHour: 0 }), routePending: true,
    statsPacket: { decisionSeq: 11, activityLeaf: 999 } };
assert.strictEqual(Events.hold(session, null, pending), previous);
Events.prepared(session);
assert.equal(session.coldLifeState.stats.decisionSeq, 10, 'ready route is same decision, not a new roll');
assert.equal(session.coldLifeState.stats.activityLeaf, 123);
assert.equal(Events.held(session), null);
assert.equal(Events.hold(session, null, pending).network.activity, null);
assert.equal(session.heldEconomy, undefined, 'pending first preparation is never installed as a funded decision');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const actualMessages = [];
Coordinator.worker = { postMessage: message => actualMessages.push(message) };
Coordinator.workerEpoch = 'route-test'; Coordinator.ready = true;
Coordinator.routeRows(base); Coordinator.routeRows(base);
assert.equal(actualMessages.length, 1);
const payload = actualMessages[0].payload;
(async () => {
    const reply = Protocol.envelope('economy_route_result', 'route-test', { characterId: 1,
        requestId: payload.requestId, key: payload.key, rows });
    await Coordinator.onMessage(reply, Coordinator.worker, 'old-epoch');
    assert.equal(Coordinator.economyRoutes.cards.get(1).rows, null, 'stale epoch has no effects');
    const partial = Protocol.envelope('economy_route_result', 'route-test', { ...reply.payload, rows: rows.slice(0, 2) });
    await Coordinator.onMessage(partial);
    assert.equal(Coordinator.economyRoutes.cards.get(1).rows, null, 'partial result cannot poison pending card');
    await Coordinator.onMessage(reply);
    assert.deepEqual(Coordinator.routeRows(base), rows, 'actual coordinator sends and accepts the compact card');
    Coordinator.economyRoutes.clear(); Coordinator.ready = false; Coordinator.worker = null;
    console.log('PASS bounded route cards, stale epoch/key/partial replies, event anchors and held pending decisions');
})().catch(error => { console.error(error); process.exitCode = 1; });
