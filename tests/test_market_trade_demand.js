'use strict';
const assert = require('node:assert/strict');
// Pins the x50 window (an hour); the x1 window is checked below.
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('../src/Global');
invoke('GameServer/DataCache').init();
const Counters = require('../src/GameServer/Bot/Economy/MarketCounters');
const Flow = require('../src/GameServer/Bot/Economy/MarketTradeDemand');
const Shots = require('../src/GameServer/Bot/Economy/ShotTradeDemand');
const Telemetry = require('../src/GameServer/Bot/Economy/MarketTelemetry');
const now = Date.now(), rows = new Map();
invoke('GameServer/AfkTrade/AfkTradeService');
Counters.reset();
Counters.publish({ register: (_name, source) => source.allRows().forEach(row => rows.set(row[0], row)),
    changed: (_name, row) => rows.set(row[0], row) });
const board = [{ selfId: 1464, quantity: 100, unitPrice: 80, town: 'Giran', occurredAt: now - 1000 }];
const fixed = [{ selfId: 1464, quantity: 1000, town: 'Giran', occurredAt: now - 600000 },
    { selfId: 1464, quantity: 2000, town: 'Giran', occurredAt: now - 300000 }];
Counters.load(board, fixed);
const replayed = Flow.forecast(1464, 'Giran', now);
assert(replayed.applicableUnits > 1000, 'fixed merchants reveal the shot flow despite almost no peer sales');
assert.equal(Counters.itemDeals(1464).deals, 1, 'supply receipts do not inflate peer trading experience');
assert.deepEqual(Counters.itemDeals(1464).prices, [80], 'fixed prices do not become peer price evidence');
const obsolete = [2, 3].map(days => ({ selfId: 2275, quantity: 100, unitPrice: 20000,
    town: 'Giran', occurredAt: now - days * 24 * 3600000 }));
Counters.reset(); Counters.load([...obsolete, ...board], fixed);
assert.equal(Counters.itemDeals(2275).deals, 2, 'old price observations remain available');
assert.equal(Flow.forecast(2275, 'Giran', now), null, 'restart does not revive demand for obsolete recipes');
Flow.reset(); Flow.load([...board, ...fixed].map(row => ({ ...row, enchant: 0 })).sort((a, b) => a.occurredAt - b.occurredAt));
assert.deepEqual(Flow.forecast(1464, 'Giran', now), replayed, 'restart replay preserves chronological decay');
const liveReceipts = [...board, ...fixed].map((row, at) => ({ ...row, enchant: 0, occurredAt: now + (at + 1) * 1000 }));
Flow.reset(); Flow.load(liveReceipts);
const ordered = Flow.forecast(1464, 'Giran', now + 3000);
Flow.reset(); Flow.load(liveReceipts.slice().reverse());
const late = Flow.forecast(1464, 'Giran', now + 3000);
assert.equal(late.applicableUnits, ordered.applicableUnits);
assert(Math.abs(late.arrivalsPerHour - ordered.arrivalsPerHour) < 1e-12,
    'a late receipt is decayed to the current observation instead of inflating earlier flow');
const offer = { selfId: 2511, price: 1750, town: 'Giran', sourceType: 'configured_store', sellerKind: 'fixed' };
Telemetry.purchase(offer, 1000); Telemetry.purchase(offer, 1000);
assert(Shots.forecast(2511, 'Giran'), 'live completed fixed purchases reach the producer forecast');
assert.equal(Counters.itemDeals(2511).deals, 0);
assert.equal(Shots.forecast(2511, 'Dion'), null, 'public flow retains its actual town');
Counters.deal(1881, 9000, 100, now - 1000, 11, 'Giran', 12);
Counters.deal(1881, 9000, 100, now, 11, 'Giran', 13);
assert(Flow.forecast(1881, 'Giran', now), 'completed material purchases inform ordinary listings too');
assert.equal(Shots.forecast(1881, 'Giran', now), null, 'material flow never authorizes shot production');
assert.equal(Flow.forecast(2275, 'Giran', now), null, 'listing an unpopular recipe creates no buyer flow');
assert.equal(Flow.forecast(1881, 'Giran', now + 24 * 3600000), null, 'old purchases decay out');
// At x1 deals come about fifty times slower and the window stretches to fifty hours.
process.env.L2NODE_PROGRESSION_RATE = 'x1';
invoke('GameServer/ProgressionRates').reset();
assert(Flow.forecast(1881, 'Giran', now + 24 * 3600000), 'x1: a day-old purchase still counts');
assert.equal(Flow.forecast(1881, 'Giran', now + 50 * 24 * 3600000), null, 'x1: it decays out over weeks');
assert.equal(Flow.replayMs(), 50 * 24 * 3600000, 'x1: a start replays the last 50 days');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
invoke('GameServer/ProgressionRates').reset();
const native = Flow.forecast(1881, 'Giran', now);
Flow.useTable(() => rows);
assert.deepEqual(Flow.forecast(1881, 'Giran', now), native, 'worker and main see the same public aggregate');
Flow.reset();
console.log('PASS public fixed/peer flow, restart ordering, material visibility and worker parity');
