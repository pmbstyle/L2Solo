'use strict';
// Task 4 B4, E198 (2): a buy ad's owner refusing its own ad (need changed)
// asks the owner to plan the same need once more, once per ad revision; a
// sell ad refusal (the caller's own need) asks nothing.
const assert = require('node:assert/strict');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const point = { locX: 0, locY: 0, locZ: 0 };
const route = { fee: 0, scroll: false, method: 'walk', durationMs: 0 };
let record = null;
const phases = new Map([[1, 'cold'], [2, 'cold']]);
const calls = [];
const coord = {
    // Only the payer's worker issues certificates; the owner has none now.
    requestMeetingPreparation: async (id, request) => ({ approved: true, token: request.token, characterId: id,
        sequence: 1, route, certificates: [] }),
    meetingPreparationCurrent: () => true,
    cancelMeetingPreparation: () => {},
    requestEconomyRefresh: id => { calls.push(['refresh', id]); return true; },
    requestEconomyLook: id => { calls.push(['look', id]); return true; }
};
const hotReview = { ownerChanged: (id, reason) => calls.push(['review', id, reason]) };
const native = {
    fetchAfkTradeShop: async () => record,
    // The seller (the non-owner side) holds the stock either way.
    prepareTradeParticipant: async id => ({ sequence: 1, revision: 0, phase: phases.get(id), ownerId: 'legacy_main', leaseId: null,
        hotAt: 0, inventory: id === (record.storeType === 3 ? 1 : 2) ? [{ id: 30, selfId: 1867, amount: 2, enchant: 0 }] : [] }),
    acceptTradeMeeting: async () => { throw Error('no admission without a certificate'); },
    fetchTradeMeeting: async () => null
};
global.utils = { infoWarn: () => {} };
global.invoke = name => ({ Database: native,
    'GameServer/Bot/Population/ColdSimulationCoordinator': coord,
    'GameServer/Bot/Economy/HotBoardReviewService': hotReview,
    'GameServer/Bot/Population/BotLifeState': { cachedState: id => ({ characterId: id, phase: phases.get(id),
        simulation: { revision: 0, ownerId: 'legacy_main', leaseId: null }, timing: {}, loc: point }), acceptLifecycleRow: () => {} },
    'GameServer/World/World': { registeredActorById: () => null }
})[name];
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const ad = (storeType, revision) => ({ id: 10, ownerId: 2, storeType, custodyPolicy: 1, revision, town: 'Giran', ...point,
    lines: [{ id: 11, selfId: 1867, count: 2, price: 100 }] });
(async () => {
    try {
        record = ad(3, 1);
        await Service.trade(1, { shopId: 10 }, 1867, 1); await settle();
        assert.deepEqual(calls, [['refresh', 2]], 'the cold owner of a refused buy ad plans its need once more');
        await Service.trade(1, { shopId: 10 }, 1867, 1); await settle();
        assert.equal(calls.length, 1, 'the same ad revision does not ask again on every later refusal');
        record = ad(3, 2);
        await Service.trade(1, { shopId: 10 }, 1867, 1); await settle();
        assert.deepEqual(calls[1], ['refresh', 2], 'a republished ad (new revision) may ask again');
        calls.length = 0;
        phases.set(2, 'hot'); record = ad(3, 3);
        await Service.trade(1, { shopId: 10 }, 1867, 1); await settle();
        assert.deepEqual(calls, [['look', 2], ['review', 2, 'line']], 'a hot owner looks again and its board review runs');
        calls.length = 0;
        phases.set(2, 'cold'); record = ad(1, 4);
        await Service.trade(1, { shopId: 10 }, 1867, 1); await settle();
        assert.deepEqual(calls, [], 'a sell ad refusal is the caller\'s own need: nothing is asked of the owner');
        console.log('PASS Task 4 buy ad refusal: owner replans once per ad revision, cold and hot, not on sell ads');
    } finally { Service.reset?.(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
