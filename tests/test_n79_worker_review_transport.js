const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

// Exercise the real worker event/command boundary. The price decision
// is independently tested; this fixture supplies an unchanged quote update.
const update = { recordId: 7, lineId: 11, expectedRevision: 4,
    previousPricing: { price: 100, seenCounter: 2, seenItem: 1, rival: 0, worth: 0, seenFills: 0 },
    pricing: { price: 100, seenCounter: 3, seenItem: 2, rival: 100, worth: 0, seenFills: 0 } };
const source = `
const { parentPort, workerData } = require('worker_threads');
require(workerData.workerPath);
invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan = () => ({
    acquisitionPlan: { status: 'active', strategy: 'farm', partyNeed: 'solo_ok', next: {} },
    replanContext: {}, reusablePartyRequest: false, excludedSpotIds: new Set()
});
invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan = () => null;
invoke('GameServer/Bot/Economy/MarketPricing').look = (state, lines) => {
    const count = invoke('GameServer/Bot/Economy/MarketCounters').counter('material none').deals;
    parentPort.postMessage({ trace: 'look', ownerId: state.characterId, count });
    return { updates: [{ ...workerData.update, previousPricing: lines[0].pricing,
        pricing: { ...workerData.update.pricing, seenCounter: count } }],
        reprices: [], withdrawals: [] };
};
`;

(async () => {
    const epoch = 'n79-review-transport';
    const worker = new Worker(source, { eval: true, workerData: { workerEpoch: epoch, update,
        workerPath: process.env.N79_WORKER_PATH || path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    const received = [];
    let fault;
    worker.on('error', (error) => { fault = error; });
    worker.on('message', (message) => received.push(message));
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, epoch, payload));
    const until = async (predicate) => {
        const deadline = Date.now() + 20000;
        while (!received.some(predicate)) {
            if (fault) throw fault;
            const failure = received.find((m) => m.type === 'fault');
            if (failure) throw new Error(JSON.stringify(failure.payload));
            if (Date.now() >= deadline) throw new Error(`worker timeout: ${received.map((m) => m.type).join(',')}`);
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return received.find(predicate);
    };
    try {
        await until((m) => m.type === 'ready' && m.payload.phase === 'loaded');
        const spot = { id: 'n79-field', name: 'N79 Field', center: { locX: 123000, locY: 123000, locZ: -3000 },
            minLevel: 28, maxLevel: 32, avgLevel: 30, density: 12, levelCounts: { 30: 12 },
            npcSelfIds: [], npcEntries: [], mob: { hp: 1, damage: 1 },
            rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 } };
        send('catalog_page', { catalog: 'spots', rows: [spot], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true,
            rows: [[7, [7, 'shop', 1, 4242, 'Giran', 1, [[11, 1864, 0, 100, 100, update.previousPricing, 0]], 4]],
                [8, [8, 'shop', 1, 4243, 'Giran', 1, [[12, 1463, 0, 100, 100, update.previousPricing, 0]], 4]]], removed: [] },
            { name: 'market', from: null, to: 0, full: true, rows: [
                ['c:material none', ['c:material none', 2, 1, Date.now(), 0, 0, null]]
            ], removed: [] }] });
        send('init', { config: { loopIntervalMs: 10, flushTargetMs: 10, flushHardMs: 50 } });
        await until((m) => m.type === 'ready' && m.payload.phase === 'running');
        const now = Date.now();
        const state = {
            characterId: 4242, name: 'ReviewTrader', accountName: 'bot_review_trader', level: 30,
            phase: 'cold', activity: 'hunting', spotId: spot.id, currentRegion: spot.name, loc: spot.center,
            inventory: {}, adena: 1000, vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
            timing: { lastResolvedAt: now - 45000, nextResolveAt: now + 60000 },
            stats: { generatedCold: true, classId: 0, role: 'dps', equipment: [] }
        };
        const context = { spot, route: null };
        send('snapshot_page', { done: true, ack: true, rows: [{ state, context },
            { state: { ...state, characterId: 4243, name: 'OtherCounter' }, context }] });
        await until((m) => m.type === 'ready' && m.payload.phase === 'state_loaded');
        const counter = (from, to, count, extra = {}) => send('table_page', { tables: [{
            name: 'market', from, to, full: false,
            rows: [['c:material none', ['c:material none', count, 1, Date.now(), 0, 0, null]]], removed: [], ...extra
        }] });
        const commands = () => received.filter((m) => m.type === 'command_request');
        counter(0, 1, 3);
        const first = await until((m) => m.type === 'command_request');
        const request = first.payload.requests[0];
        assert.strictEqual(request.kind, 'market_review');
        assert.deepStrictEqual(request.market.updates, [update], 'metadata-only evidence reaches the native command');
        assert.strictEqual(request.characterId, 4242);
        assert.deepStrictEqual(request.state.timing, state.timing, 'market evidence does not manufacture a combat due time');
        assert.strictEqual(request.state.stats.priceBeliefs, undefined);
        counter(1, 2, 4);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(commands().length, 1, 'new deals wait for the pending native command');
        const publish = (from, to, pricing) => send('table_page', { tables: [{ name: 'board', from, to, full: false,
            rows: [[7, [7, 'shop', 1, 4242, 'Giran', 1, [[11, 1864, 0, 100, 100, pricing, 0]], 4]]], removed: [] }] });
        publish(0, 1, update.pricing);
        send('command_ack', { results: [{ ok: true, characterId: 4242, state, context,
            commandId: request.commandId, commandCheckpoint: request.commandCheckpoint,
            marketCommandId: request.commandId }] });
        const second = await until((m) => m.type === 'command_request' && m !== first);
        const secondUpdate = second.payload.requests[0].market.updates[0];
        assert.deepStrictEqual(secondUpdate.previousPricing, update.pricing);
        assert.strictEqual(secondUpdate.pricing.seenCounter, 4, 'a deal during the command is retained');
        publish(1, 2, secondUpdate.pricing);
        send('command_ack', { results: [{ ok: true, characterId: 4242, state, context,
            commandId: second.payload.requests[0].commandId,
            commandCheckpoint: second.payload.requests[0].commandCheckpoint,
            marketCommandId: second.payload.requests[0].commandId }] });
        counter(2, 3, 4);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(commands().length, 2, 'replayed counters are inert');
        counter(99, 100, 5);
        await until((m) => m.type === 'table_resync');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(commands().length, 2, 'a counter gap cannot review stale tables');
        counter(null, 10, 5, { full: true, last: 0 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(commands().length, 2, 'a partial full copy cannot review partial tables');
        send('table_page', { tables: [{ name: 'market', from: 10, to: 10, full: false, last: 1, rows: [], removed: [] }] });
        await until((m) => m.type === 'command_request' && m !== first && m !== second);
        assert.strictEqual(received.filter((m) => m.trace === 'look' && m.ownerId === 4243).length, 0,
            'a counter event does not scan or review a different-counter owner');
        assert.strictEqual(received.some((m) => m.type === 'claim_request' || m.type === 'proposal_batch'), false,
            'market events stay independent of combat');
        assert.strictEqual(received.some((m) => m.type === 'fault'), false);
        console.log('Real worker delivers indexed, fenced metadata reviews independently of combat');
    } finally { await worker.terminate(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
