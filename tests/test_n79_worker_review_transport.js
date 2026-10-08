const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

// The real worker mirrors counters without waking 300 owners. A single
// owner's naturally due resolve may carry a changed quote in its proposal.
const source = `
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.workerPath);
invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan = () => ({
    acquisitionPlan: { status: 'active', strategy: 'farm', partyNeed: 'solo_ok', next: {} },
    replanContext: {}, reusablePartyRequest: false, excludedSpotIds: new Set(),
    economy: { statsPacket: {}, network: {} }
});
invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan = () => null;
invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo = ({ timestamp }) => ({
    patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 60000
});
invoke('GameServer/Bot/Population/BotLifeState').prepareResolve = async (state, result, opts) =>
    ({ ...state, updatedAt: opts.timestamp });
invoke('GameServer/Bot/AI/TendencyRoll').roll = () => 0;
invoke('GameServer/Bot/Economy/MarketPricing').traderContext = (state, opts) => ({
    ...opts, hour: 0, understanding: .3
});
invoke('GameServer/Bot/Economy/MarketPricing').look = (state, lines, ctx) => {
    parentPort.postMessage({ trace: 'look', ownerId: state.characterId });
    return workerData.unchanged ? null : { reprices: [{ recordId: lines[0].recordId,
        lineId: lines[0].lineId, expectedRevision: 4, previousPricing: lines[0].pricing,
        price: 110, pricing: { ...lines[0].pricing, price: 110, seenCounter: 3, seenAt: ctx.timestamp } }], withdrawals: [] };
};`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function check(unchanged) {
    const epoch = `own-board-transport-${unchanged}`;
    const worker = new Worker(source, { eval: true, workerData: { workerEpoch: epoch, unchanged,
        workerPath: process.env.N79_WORKER_PATH || path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    const received = [];
    let fault;
    worker.on('error', error => { fault = error; });
    worker.on('message', message => received.push(message));
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    const until = async predicate => {
        const deadline = Date.now() + 10000;
        while (!received.some(predicate)) {
            if (fault) throw fault;
            const failure = received.find(message => message.type === 'fault');
            if (failure) throw Error(JSON.stringify(failure.payload));
            if (Date.now() >= deadline) throw Error(`worker timeout: ${received.map(message => message.type || message.trace).join(',')}`);
            await pause(10);
        }
        return received.find(predicate);
    };
    try {
        await until(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const now = Date.now();
        const spot = { id: 'board-field', name: 'Board Field', center: { locX: 123000, locY: 123000, locZ: -3000 },
            minLevel: 28, maxLevel: 32, avgLevel: 30, density: 12, levelCounts: { 30: 12 },
            npcSelfIds: [], npcEntries: [], mob: { hp: 1, damage: 1 },
            rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 } };
        send('catalog_page', { catalog: 'spots', rows: [spot], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        const pricing = { price: 100, seenCounter: 2, seenAt: 0, seenItem: 1, rival: 0, worth: 0, seenFills: 0 };
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true,
            rows: Array.from({ length: 300 }, (_, i) => [7 + i, [7 + i, 'shop', 1, 4242 + i, 'Giran', 1,
                [[11 + i, 1864, 0, 100, 100, pricing, 0]], 4]]), removed: [] },
            { name: 'market', from: null, to: 0, full: true,
                rows: [['c:material none', ['c:material none', 2, 1, now, 0, 0, null]]], removed: [] }] });
        send('init', { config: { loopIntervalMs: 10, flushTargetMs: 10, flushHardMs: 50 } });
        await until(message => message.type === 'ready' && message.payload.phase === 'running');
        const state = { characterId: 4242, name: 'ReviewOwner', accountName: 'bot_review_owner', level: 30,
            phase: 'cold', activity: 'hunting', spotId: spot.id, currentRegion: spot.name, loc: spot.center,
            inventory: {}, adena: 1000, vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
            timing: { lastResolvedAt: now - 45000, nextResolveAt: now + 600000 },
            simulation: { ownerId: 'legacy_main', revision: 0, leaseId: null, leaseUntil: 0 },
            stats: { generatedCold: true, classId: 0, role: 'dps', equipment: [] } };
        const context = { spot, route: null };
        for (let offset = 0; offset < 300; offset += 64) send('snapshot_page', {
            done: offset + 64 >= 300, ack: offset + 64 >= 300,
            rows: Array.from({ length: Math.min(64, 300 - offset) }, (_, i) => ({
                state: { ...state, characterId: 4242 + offset + i, name: `ReviewOwner${offset + i}` }, context }))
        });
        await until(message => message.type === 'ready' && message.payload.phase === 'state_loaded');
        send('table_page', { tables: [{ name: 'market', from: 0, to: 1, full: false,
            rows: [['c:material none', ['c:material none', 3, 1, now, 0, 0, null]]], removed: [] }] });
        await pause(100);
        assert.equal(received.some(message => ['command_request', 'claim_request', 'proposal_batch'].includes(message.type)
            || message.trace === 'look'), false, 'one deal wakes zero of 300 owners');
        const due = { ...state, simulation: { ...state.simulation, revision: 1 },
            timing: { ...state.timing, nextResolveAt: Date.now() - 1 } };
        send('snapshot_page', { done: true, rows: [{ state: due, context }] });
        const claim = await until(message => message.type === 'claim_request');
        assert.deepEqual(claim.payload.candidates.map(row => row.characterId), [4242]);
        send('claim_ack', { grants: [{ ok: true, characterId: 4242, ownerId: 'cold_simulation_owner', revision: 2,
            leaseId: 'own-look-lease', leaseUntil: Date.now() + 30000 }] }, claim.msgId);
        const proposal = (await until(message => message.type === 'proposal_batch')).payload.proposals[0];
        assert.equal(proposal.token.characterId, 4242);
        assert.equal(received.filter(message => message.trace === 'look').length, 1);
        assert.equal(received.some(message => message.type === 'command_request'), false, 'board looks use no command');
        assert.equal(Object.hasOwn(proposal, 'market'), !unchanged);
        if (!unchanged) {
            assert.equal(proposal.market.reprices[0].price, 110);
            assert.equal(proposal.market.reprices[0].pricing.seenCounter, 3);
            assert(proposal.market.reprices[0].pricing.seenAt > 0);
            assert.equal(proposal.market.updates, undefined, 'no metadata-only review crosses IPC');
        }
        console.log(`Real worker 300-owner fanout=0; own resolve ${unchanged ? 'unchanged quote has no market field' : 'carries only its changed quote'}: PASS`);
    } finally { await worker.terminate(); }
}
(async () => { await check(false); await check(true); })().catch(error => { console.error(error); process.exitCode = 1; });
