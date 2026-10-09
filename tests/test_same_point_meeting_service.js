'use strict';
const assert = require('node:assert/strict');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const rows = new Map([1, 2].map(id => [id, { id, actorA: 1, actorB: id + 1, state: 'accepted', revision: 1,
    locX: 1000, locY: 0, locZ: 0, routeA: JSON.stringify({ method: id === 1 ? 'walk' : 'meeting:1' }), nextLegA: 1 }]));
const states = new Map([1, 2, 3].map(id => [id, { characterId: id, phase: 'cold', activity: id === 1 ? 'shopping' : 'traveling',
    vitals: { hp: 100 }, stats: { tradeMeeting: [id === 3 ? 2 : 1, 1] }, loc: { locX: 0, locY: 0, locZ: 0 } }]));
let listener, arrived = false; const paid = [], acknowledged = [], cancelled = [];
const native = {
    recoverTradeMeetings: async cursor => cursor ? [] : [...rows.values()],
    fetchTradeMeeting: async id => rows.get(id),
    fetchTradeMeetingsForOwner: async id => [...rows.values()].filter(row => [row.actorA, row.actorB].includes(id) && row.state === 'accepted'),
    fetchTradeMeetingForOwner: async id => [...rows.values()].find(row => [row.actorA, row.actorB].includes(id) && row.state === 'accepted'),
    arriveTradeMeeting: async id => { const row = rows.get(id); if (arrived) row.state = 'completed'; return { meeting: { ...row, arrivalMask: 2 } }; },
    payTradeMeetingLeg: async (id, side, sequence) => { paid.push([id, side, sequence]); states.get(1).activity = 'traveling'; states.get(1).stats.travel = { meetingId: id }; return {}; },
    acknowledgeTradeMeeting: async (id, actor) => { acknowledged.push([id, actor]); if (actor === rows.get(id).actorB) rows.delete(id); },
    cancelTradeMeeting: async id => { const row = rows.get(id); cancelled.push(id); row.state = 'cancelled'; return { meeting: row }; },
    fetchAfkTradeShops: async () => []
};
global.utils = { infoWarn: (...args) => { throw Error(args.join(' ')); } };
global.invoke = name => ({ Database: native,
    'GameServer/Bot/Population/BotLifeState': { subscribeMarketReviewChanges: () => () => {}, cachedState: id => states.get(id), acceptLifecycleRow: () => {}, subscribeChanges: fn => { listener = fn; return () => {}; } },
    'GameServer/World/World': { registeredActorById: () => null, subscribeUserChanges: () => () => {} },
    'GameServer/AfkTrade/AfkTradeService': { settleOwners: async () => {}, refreshRecord: () => {}, subscribeBoardChanges: () => () => {} }
})[name];
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
(async () => {
    try {
        await Service.init(); await flush();
        assert.deepEqual(paid, [[1, 0, 1]], 'two same-point purchases start one anchored trip');
        assert.equal(Service.counters().participants, 3, 'recovery retains all bilateral participants');
        arrived = true; states.get(1).activity = 'shopping'; states.get(1).stats.travel = null;
        listener({ characterId: 1 }); await flush();
        assert.deepEqual(acknowledged, [[1, 1], [1, 2], [2, 1], [2, 3]], 'one arrival settles both separate deals');
        assert.equal(Service.counters().participants, 0, 'cleaning one deal never drops the second reference');
        rows.set(3, { id: 3, actorA: 1, actorB: 2, state: 'accepted' });
        rows.set(4, { id: 4, actorA: 1, actorB: 3, state: 'accepted' });
        assert((await Service.cancel(1)).cancelled);
        assert.deepEqual(cancelled, [3, 4], 'explicit actor cancellation releases all its commitments');
        console.log('PASS shared meeting service: recovery, one trip, one arrival settles every bilateral deal, explicit cancel all');
    } finally { Service.reset(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
