'use strict';
const assert = require('node:assert/strict');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
let lifeListener, boardListener, playerListener;
let revision = 0;
const state = { characterId: 1, phase: 'cold', simulation: { revision: 0, ownerId: 'legacy_main' }, timing: {} };
const native = { recoverTradeMeetings: async () => [],
    fetchAfkTradeShop: async () => ({ id: 1, ownerId: 2, storeType: 1, custodyPolicy: 1,
        revision: 1, lines: [{ selfId: 1867, count: 10, price: 100 }] }),
    prepareTradeParticipant: async () => ({ sequence: 1, revision: 1, phase: 'cold',
        ownerId: 'legacy_main', leaseId: null, hotAt: 0 }) };
global.invoke = name => ({
    Database: native,
    'GameServer/Bot/Population/BotLifeState': {
        cachedState: () => ({ ...state, simulation: { ...state.simulation, revision } }),
        subscribeChanges: fn => { lifeListener = fn; return () => { lifeListener = null; }; }
    },
    'GameServer/AfkTrade/AfkTradeService': {
        subscribeBoardChanges: fn => { boardListener = fn; return () => { boardListener = null; }; }
    },
    'GameServer/World/World': { registeredActorById: () => null,
        subscribeUserChanges: fn => { playerListener = fn; return () => { playerListener = null; }; } }
})[name];
function request(n) {
    return { token: `prepare-${n}`, actorA: 2 * n + 1, actorB: 2 * n + 2, seqA: 1, seqB: 1,
        town: 'Giran', point: { locX: 0, locY: 0, locZ: 0 },
        lines: [{ payer: 0, itemId: 1, selfId: 1867, count: 1, price: 100 }],
        parties: [0, 1].map(() => ({ revision: 0, sequence: 1, needRevision: 0,
            phase: 'cold', ownerId: 'legacy_main', leaseId: null, hotAt: 0,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })) };
}
(async () => {
    try {
        await Service.init();
        await assert.rejects(Service.prepareTrade(1, { shopId: 1 }, 1867, 1, { coldState: state }), /authority_changed/);
        assert.equal(Service.counters().preparations, 0, 'fresh native reads cannot authorize a stale caller');
        let id = Service.stage(request(0));
        assert.throws(() => Service.stage(request(0)), /preparation_busy/);
        revision = 1; lifeListener({ characterId: 1 });
        await assert.rejects(Service.accept(id), /preparation_missing/);
        revision = 0;
        id = Service.stage(request(0)); boardListener({ ownerIds: [2] });
        await assert.rejects(Service.accept(id), /preparation_missing/);
        id = Service.stage(request(0)); playerListener(1);
        await assert.rejects(Service.accept(id), /preparation_missing/);
        let n = 0;
        while (Service.counters().pages < 64) { Service.stage(request(n++)); }
        assert.equal(Service.counters().pages, 64);
        assert(Service.counters().bytes <= 48 * 1024);
        assert.throws(() => Service.stage(request(n)), /backpressure/);
        boardListener({ reset: true });
        assert.equal(Service.counters().pages, 0);
        assert.equal(Service.counters().preparations, 0);
        const original = request(0);
        native.fetchTradeMeetingByToken = async token => token === original.token
            ? { id: 7, actorA: original.actorA, actorB: original.actorB, revision: 1, state: 'accepted' } : null;
        native.acceptTradeMeeting = async () => { throw Error('duplicate_reservation'); };
        const replay = await Service.accept(original.token);
        assert.equal(replay.meetingId, 7, 'lost acknowledgement replays the durable token after staging was removed');
        assert.equal(Service.counters().preparations, 0);
        assert.equal(await Service.receipt(original.token, 99), null, 'another owner cannot adopt the saved receipt');
        native.fetchTradeMeetingByToken = async () => null;
        native.fetchTradeMeetingReceipt = async (token, actor) => token === original.token && actor === original.actorA
            ? { meetingId: 7, pending: false, outcome: 'completed' } : null;
        assert.equal((await Service.receipt(original.token, original.actorA)).outcome, 'completed', 'cleaned terminal receipt is owner bounded');
        console.log('Meeting preparation: stale caller, one per actor, source invalidation, disconnect and bounded release passed');
    } finally { Service.reset(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
