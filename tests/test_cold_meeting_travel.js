'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const loaded = { exports: {} }, paid = [], acked = [];
let state = { characterId: 1, phase: 'cold', activity: 'shopping', vitals: { hp: 100 }, stats: {}, loc: { locX: 0, locY: 0, locZ: 0 } };
let row = { id: 7, actorA: 1, actorB: 2, state: 'accepted', locX: 2000, locY: 0, locZ: 0,
    routeA: JSON.stringify({ scroll: false }), nextLegA: 1, routeReserveA: 100, legA: null };
let start = { locX: 0, locY: 0, locZ: 0 }, step = { locX: 1000, locY: 0, locZ: 0, fee: 100, npcId: 10 };
let lifeListener, marketListener;
const database = {
    recoverTradeMeetings: async cursor => cursor ? [] : [{ id: 7, actorA: 1, actorB: 2 }],
    fetchTradeMeeting: async () => row,
    arriveTradeMeeting: async () => ({ meeting: { ...row, arrivalMask: 2 } }),
    payTradeMeetingLeg: async (id, side, sequence, legId, fee, scroll) => {
        paid.push({ id, side, sequence, legId, fee, scroll });
        if (!row.legA) { row.legA = JSON.stringify({ sequence, legId, fee, scroll }); row.nextLegA++; row.routeReserveA -= fee; }
        return { coldLifeRows: {} };
    },
    acknowledgeTradeMeetingLeg: async (id, side, sequence) => { acked.push(sequence); row.legA = null; }
};
global.utils = { infoWarn: (...args) => { throw Error(args.join(' ')); } };
global.invoke = name => ({
    Database: database,
    'GameServer/Bot/Population/BotLifeState': { cachedState: id => id === 1 ? state : { ...state, characterId: 2, stats: { travel: {} } },
        acceptLifecycleRow: () => {}, subscribeChanges: fn => { lifeListener = fn; return () => {}; },
        subscribeMarketReviewChanges: fn => { marketListener = fn; return () => { marketListener = null; }; } },
    'GameServer/World/World': { registeredActorById: () => null, subscribeUserChanges: () => () => {},
        fetchNpcsInRadius: () => [{ fetchSelfId: () => 10, fetchLocX: () => start.locX, fetchLocY: () => 0, fetchLocZ: () => 0 }] },
    'GameServer/AfkTrade/AfkTradeService': { subscribeBoardChanges: () => () => {} }
})[name];
new Function('require', 'module', fs.readFileSync(require.resolve('../src/GameServer/AfkTrade/TradeMeetingService'), 'utf8'))(
    name => name.includes('TravelRoutes') ? { between: () => ({ start, route: { fee: step?.fee || 0, steps: step ? [step] : [] } }) }
        : name.includes('NpcObjectIndex') ? { nearTemplate: () => ({ fetchLocX: () => start.locX, fetchLocY: () => 0, fetchLocZ: () => 0 }) }
        : name.includes('TradeIntent') ? {} : require('node:module').createRequire(require.resolve('../src/GameServer/AfkTrade/TradeMeetingService'))(name), loaded);
const service = loaded.exports;
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
(async () => {
    try {
        await service.init(); await flush();
        assert.deepEqual(paid[0], { id: 7, side: 0, sequence: 1, legId: 'gk:1000:0:0', fee: 100, scroll: false });
        marketListener(1); await flush();
        assert.deepEqual(paid[1], paid[0], 'interrupted transit resumes using the original paid identity');
        assert.equal(row.routeReserveA, 0, 'replay consumes no second fare');
        state.loc = { locX: 1000, locY: 0, locZ: 0 }; start = state.loc; step = null;
        marketListener(1); lifeListener(1); await flush();
        assert.deepEqual(acked, [1]);
        assert.equal(paid.at(-1).legId, 'walk:2000:0:0');
        assert.equal(paid.at(-1).fee, 0, 'final movement is on foot');
        row.legA = null; row.nextLegA = 3; step = { locX: 3000, locY: 0, locZ: 0, fee: 200, npcId: 10 };
        lifeListener(1); await flush();
        assert.equal(paid.at(-1).legId, 'walk:2000:0:0', 'a changed unaffordable route preserves the agreement and walks');
        row.legA = JSON.stringify({ sequence: 3, legId: 'soe:1000:0:0', fee: 0, scroll: true });
        state.loc = { locX: 500, locY: 0, locZ: 0 }; step = null;
        lifeListener(1); await flush();
        assert.equal(acked.at(-1), 3, 'spent interrupted recall is acknowledged');
        assert.equal(paid.at(-1).scroll, false, 'recall recovery does not cast another scroll');
        row.legA = null; row.routeA = JSON.stringify({ method: 'walk', scroll: false });
        step = { locX: 9000, locY: 0, locZ: 0, fee: 0, npcId: 10 };
        lifeListener(1); await flush();
        assert.equal(paid.at(-1).legId, 'walk:2000:0:0', 'agreed foot travel ignores gatekeeper routes');
        state.activity = 'fighting'; const count = paid.length;
        lifeListener(1); await flush(); assert.equal(paid.length, count, 'survival pauses meeting movement');
        console.log('Cold meeting: native hops, interruption replay, arrival acknowledgement, remaining route and survival passed');
    } finally { service.reset(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
