'use strict';
const assert = require('node:assert/strict');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const waiting = new Map();
let reservations = 0, valid = true;
const point = { locX: 0, locY: 0, locZ: 0 };
const state = id => ({ characterId: id, phase: 'cold', simulation: { revision: 0, ownerId: 'legacy_main', leaseId: null }, timing: {}, loc: point });
const route = { fee: 0, scroll: false, method: 'walk', durationMs: 0 };
const coord = {
    requestMeetingPreparation: (id, request) => new Promise(resolve => waiting.set(id, () => resolve({
        approved: true, token: request.token, characterId: id, sequence: 1, route,
        certificates: id === 1 ? request.lines.map(line => [1867, line.count, 100, 8, 1867, 0, 0, 2, 100]) : []
    }))),
    meetingPreparationCurrent: () => valid,
    cancelMeetingPreparation: () => {}
};
const native = {
    fetchAfkTradeShop: async () => ({ id: 10, ownerId: 2, storeType: 1, custodyPolicy: 1, revision: 1, town: 'Giran', ...point,
        lines: [{ selfId: 1867, count: 2, price: 100 }] }),
    prepareTradeParticipant: async id => ({ sequence: 1, revision: 0, phase: 'cold', ownerId: 'legacy_main', leaseId: null,
        hotAt: 0, inventory: id === 2 ? [{ id: 30, selfId: 1867, amount: 2, enchant: 0 }] : [] }),
    acceptTradeMeeting: async (request, prep) => {
        assert(prep.freshPreparation); assert.equal(prep.validatePreparation(request), true);
        assert.equal(request.lines[0].certificate[1], request.lines[0].count);
        reservations++;
        return { pending: true, meeting: { id: 7, actorA: 1, actorB: 2, token: request.token, state: 'accepted', revision: 1 } };
    },
    fetchTradeMeeting: async () => null
};
global.utils = { infoWarn: () => {} };
global.invoke = name => ({ Database: native,
    'GameServer/Bot/Population/ColdSimulationCoordinator': coord,
    'GameServer/Bot/Population/BotLifeState': { cachedState: state, acceptLifecycleRow: () => {} },
    'GameServer/World/World': { registeredActorById: () => null }
})[name];
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
    try {
        const result = await Service.trade(1, { shopId: 10 }, 1867, 1);
        assert.equal(result.pending, true);
        assert.equal(result.outcome, 'preparing');
        assert.equal(reservations, 0, 'lifecycle command returns before either worker reply');
        assert.equal((await Service.receipt(result.token, 1)).outcome, 'preparing');
        waiting.get(1)(); await tick();
        assert.equal(reservations, 0, 'one side cannot reserve both bags');
        waiting.get(2)(); await tick();
        assert.equal(reservations, 1, 'both fresh preparations cause one native admission');
        assert.equal(Service.counters().pages, 0);
        const second = await Service.trade(1, { shopId: 10 }, 1867, 1);
        valid = false;
        waiting.get(1)(); waiting.get(2)(); await tick();
        assert.equal(reservations, 1, 'invalidated worker/source moves no assets');
        assert.equal(Service.counters().preparations, 0);
        assert(second.token !== result.token);
        valid = true;
        const originalPrepare = native.prepareTradeParticipant;
        native.prepareTradeParticipant = async id => ({ ...await originalPrepare(id),
            inventory: id === 2 ? [{ id: 30, selfId: 1867, amount: 1, enchant: 0 }, { id: 31, selfId: 1867, amount: 1, enchant: 0 }] : [] });
        const originalAccept = native.acceptTradeMeeting;
        native.acceptTradeMeeting = async (request, prep) => {
            assert.equal(request.lines.length, 2, 'one agreed quantity can use two physical stacks');
            assert.equal(request.lines.reduce((sum, line) => sum + line.count, 0), 2);
            return originalAccept(request, prep);
        };
        await Service.trade(1, { shopId: 10 }, 1867, 2);
        waiting.get(1)(); waiting.get(2)(); await tick();
        assert.equal(reservations, 2);
        console.log('Bilateral preparation: release command tail, both consents, original pending reference and invalidation passed');
    } finally { Service.reset(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
