'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), { createRequire } = require('node:module');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Life = invoke('GameServer/Bot/Population/BotLifeState'), Clan = invoke('GameServer/Clan/ClanService');
const savedSync = Clan.syncColdMember; Clan.syncColdMember = () => {};
const originalInvoke = global.invoke, paid = [], acked = [];
const id = 930001;
let row = { id: 7, actorA: id, actorB: id + 1, state: 'accepted', locX: 2000, locY: 0, locZ: 0,
    routeA: JSON.stringify({ method: 'soe_gatekeeper', scroll: true }), nextLegA: 2, routeReserveA: 0,
    legA: JSON.stringify({ sequence: 1, legId: 'soe:1000:0:0', fee: 0, scroll: true }) };
let state = { characterId: id, phase: 'cold', activity: 'traveling', vitals: { hp: 100 },
    stats: { tradeMeeting: [7, 1], travel: { meetingId: 7 } }, loc: { locX: 0, locY: 0, locZ: 0 },
    inventory: {}, simulation: { ownerId: 'cold_worker', revision: 1, leaseId: null } };
function publish(patch) { state = { ...state, ...patch, simulation: { ...state.simulation, revision: state.simulation.revision + 1 } };
    Life.acceptSimulationOwnership(id, state.simulation, state); }
Life.acceptSimulationOwnership(id, state.simulation, state);
Life.acceptSimulationOwnership(id + 1, state.simulation, { ...state, characterId: id + 1 });
const db = {
    recoverTradeMeetings: async cursor => cursor ? [] : [{ id: 7, actorA: id, actorB: id + 1 }],
    fetchTradeMeeting: async () => row,
    arriveTradeMeeting: async () => ({ meeting: { ...row, arrivalMask: 2 } }),
    acknowledgeTradeMeetingLeg: async (_, side, sequence) => { assert.equal(side, 0); acked.push(sequence); row.legA = null; },
    payTradeMeetingLeg: async (_, side, sequence, legId, fee, scroll) => {
        paid.push({ side, sequence, legId, fee, scroll }); row.legA = JSON.stringify({ sequence, legId, fee, scroll }); row.nextLegA++;
        publish({ activity: 'traveling', stats: { ...state.stats, travel: { meetingId: 7 } } });
        return { coldLifeRows: {} };
    }
};
global.invoke = name => ({ Database: db, 'GameServer/Bot/Population/BotLifeState': Life,
    'GameServer/World/World': { registeredActorById: () => null, subscribeUserChanges: () => () => {} },
    'GameServer/AfkTrade/AfkTradeService': { subscribeBoardChanges: () => () => {} }
})[name] || originalInvoke(name);
const file = require.resolve('../src/GameServer/AfkTrade/TradeMeetingService'), loaded = { exports: {} }, nativeRequire = createRequire(file);
new Function('require', 'module', fs.readFileSync(file, 'utf8'))(name => name.includes('TravelRoutes')
    ? { between: () => ({ start: state.loc, route: { fee: 0, steps: [] } }) } : nativeRequire(name), loaded);
const service = loaded.exports;
const flush = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
(async () => {
    try {
        await service.init(); await flush(); assert.equal(paid.length, 0, 'in-flight recall waits');
        // This is the actual worker-commit publication, not the ordinary lifecycle listener mocked by older travel tests.
        publish({ activity: 'shopping', loc: { locX: 1000, locY: 0, locZ: 0 }, stats: { ...state.stats, travel: null } });
        await flush();
        assert.deepEqual(acked, [1], 'native committed arrival acknowledges the consumed recall');
        assert.deepEqual(paid, [{ side: 0, sequence: 2, legId: 'walk:2000:0:0', fee: 0, scroll: false }], 'remaining physical leg starts without another fare or scroll');
        Life.acceptSimulationOwnership(id, state.simulation, state); await flush();
        assert.equal(paid.length, 1, 'unchanged publication does not replay payment');
        service.reset();
        publish({ activity: 'shopping', stats: { ...state.stats, travel: null } }); await flush();
        assert.equal(paid.length, 1, 'reset releases the native publication subscription');
        console.log('PASS native worker arrival publication -> original recall acknowledgement -> remaining walk, dedup and reset');
    } finally { service.reset(); global.invoke = originalInvoke; Clan.syncColdMember = savedSync; }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
