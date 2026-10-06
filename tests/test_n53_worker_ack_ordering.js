const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const workerPath = process.env.N53_WORKER_PATH
    || path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
const source = `
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.workerPath);
invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan = () => ({
    acquisitionPlan: { status: 'active', strategy: 'farm', partyNeed: 'solo_ok', next: {} },
    replanContext: {}, reusablePartyRequest: false, excludedSpotIds: new Set()
});
invoke('GameServer/Bot/Population/PartyRequestPlanner').partyRequestForPlan = () => null;
invoke('GameServer/Bot/Economy/MarketPricing').look = (state, lines) => {
    const count = invoke('GameServer/Bot/Economy/MarketCounters').counter('material none').deals;
    parentPort.postMessage({ trace: 'look', ownerId: state.characterId, count });
    return { updates: [{ recordId: lines[0].recordId, lineId: lines[0].lineId, expectedRevision: 4,
        previousPricing: lines[0].pricing,
        pricing: { ...lines[0].pricing, seenCounter: count } }], reprices: [], withdrawals: [] };
};
`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const commandReceipt = request => ({ commandId: request.commandId, commandCheckpoint: request.commandCheckpoint });
async function check(mode) {
    const pressure = mode === 'pressure';
    const owners = pressure ? 20 : 1;
    const epoch = `n53-ack-${mode}`;
    const worker = new Worker(source, { eval: true, workerData: { workerEpoch: epoch,
        workerPath } });
    const received = [];
    let fault;
    worker.on('error', error => { fault = error; });
    worker.on('message', message => received.push(message));
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, epoch, payload));
    const until = async predicate => {
        const deadline = Date.now() + 10000;
        while (!received.some(predicate)) {
            if (fault) throw fault;
            const failure = received.find(message => message.type === 'fault');
            if (failure) throw new Error(JSON.stringify(failure.payload));
            if (Date.now() >= deadline) throw new Error(`worker timeout: ${received.map(message => message.type || message.trace).join(',')}`);
            await pause(10);
        }
        return received.find(predicate);
    };
    const commands = () => received.filter(message => message.type === 'command_request');
    try {
        await until(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const spot = { id: 'ack-field', name: 'Ack Field', center: { locX: 123000, locY: 123000, locZ: -3000 },
            minLevel: 28, maxLevel: 32, avgLevel: 30, density: 12, levelCounts: { 30: 12 },
            npcSelfIds: [], npcEntries: [], mob: { hp: 1, damage: 1 },
            rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 } };
        send('catalog_page', { catalog: 'spots', rows: [spot], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        const pricing = { price: 100, seenCounter: 2, seenItem: 1, rival: 0, worth: 0, seenFills: 0 };
        const boardRow = (p, ownerId = 4242) => {
            const offset = ownerId - 4242;
            return [7 + offset, 'shop', 1, ownerId, 'Giran', 1, [[11 + offset, 1864, 0, 100, 100, p, 0]], 4];
        };
        const counterRow = count => ['c:material none', count, 1, Date.now(), 0, 0, null];
        send('table_page', { tables: [
            { name: 'board', from: null, to: 0, full: true,
                rows: Array.from({ length: owners }, (_, i) => [7 + i, boardRow(pricing, 4242 + i)]), removed: [] },
            { name: 'market', from: null, to: 0, full: true, rows: [['c:material none', counterRow(2)]], removed: [] }
        ] });
        send('init', { config: { loopIntervalMs: 10, flushTargetMs: 10, flushHardMs: 50,
            ...(pressure ? { maxInFlight: 2 } : {}) } });
        await until(message => message.type === 'ready' && message.payload.phase === 'running');
        const now = Date.now();
        const state = { characterId: 4242, name: 'AckOwner', accountName: 'bot_ack_owner', level: 30,
            phase: 'cold', activity: 'hunting', spotId: spot.id, currentRegion: spot.name, loc: spot.center,
            inventory: {}, adena: 1000, vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
            timing: { lastResolvedAt: now - 45000, nextResolveAt: now + 60000 },
            stats: { generatedCold: true, classId: 0, role: 'dps', equipment: [] } };
        const context = { spot, route: null };
        send('snapshot_page', { done: true, ack: true, rows: Array.from({ length: owners }, (_, i) => ({
            state: { ...state, characterId: 4242 + i, name: `AckOwner${i}` }, context
        })) });
        await until(message => message.type === 'ready' && message.payload.phase === 'state_loaded');
        send('table_page', { tables: [{ name: 'market', from: 0, to: 1, full: false,
            rows: [['c:material none', counterRow(3)]], removed: [] }] });
        const first = await until(message => message.type === 'command_request');
        assert.equal(first.payload.requests[0].kind, 'market_review');
        const commandId = first.payload.requests[0].commandId;
        assert.equal(typeof commandId, 'string', 'market commands identify their own ack');
        assert(commandId.length > 0);
        if (pressure) {
            await pause(100);
            const pending = commands().flatMap(message => message.payload.requests);
            assert.equal(pending.length, 2, 'market commands share the existing kernel in-flight limit');
            assert.equal(new Set(pending.map(request => request.characterId)).size, 2);
            const done = pending[0];
            send('table_page', { tables: [{ name: 'board', from: 0, to: 1, full: false,
                rows: [[done.market.updates[0].recordId,
                    boardRow(done.market.updates[0].pricing, done.characterId)]], removed: [] }] });
            send('command_ack', { results: [{ ok: true, characterId: done.characterId,
                ...commandReceipt(done), state: done.state, context: done.context,
                marketDeferred: false, marketCommandId: done.commandId }] });
            await until(message => message.type === 'command_request'
                && !pending.some(request => request.commandId === message.payload.requests[0].commandId));
            await pause(100);
            const afterAck = commands().flatMap(message => message.payload.requests);
            assert.equal(afterAck.length, 3, 'one ack frees exactly one slot for the next affected owner');
            assert.equal(new Set(afterAck.map(request => request.characterId)).size, 3,
                'remaining indexed owners stay queued instead of being lost or duplicating the acknowledged owner');
            assert.equal(received.some(message => message.type === 'claim_request'
                || message.type === 'proposal_batch'), false, 'pressure draining never starts early combat');
            console.log('Market reviews obey shared pressure; ack frees one queued owner slot');
            return;
        }
        if (mode === 'fence') {
            send('fence', { characterId: 4242, deadlineAt: Date.now() + 1000 });
            await until(message => message.type === 'fence_ack');
        }
        const ackState = mode === 'snapshot'
            ? { ...state, simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: null } }
            : state;
        if (mode === 'snapshot') {
            send('snapshot_page', { done: true, rows: [{ state: ackState, context }] });
            await pause(100);
        }
        // A durable fresh checkpoint and another counter deal reach the worker
        // before the first command's final ack. This ordering is supported by
        // the channel/ack protocol and by stale native CAS returning zero.
        send('table_page', { tables: [{ name: 'board', from: 0, to: 1, full: false,
            rows: [[7, boardRow({ ...pricing, seenCounter: 3 })]], removed: [] },
        { name: 'market', from: 1, to: 2, full: false,
            rows: [['c:material none', counterRow(4)]], removed: [] }] });
        if (mode === 'snapshot') await pause(100);
        send('command_ack', { results: [{ ok: true, characterId: 4242, state: ackState, context,
            ...commandReceipt(first.payload.requests[0]),
            marketDeferred: mode !== 'fence', marketCommandId: commandId }] });
        await pause(150);
        const afterAck = commands().length;
        assert.equal(received.some(message => message.type === 'claim_request'), false);
        if (mode !== 'fence') {
            assert.equal(afterAck, 2, 'fresh evidence delivered while pending survives a zero-applied deferred ack');
            const second = commands()[1].payload.requests[0];
            assert.notEqual(second.commandId, commandId);
            assert.equal(second.market.updates[0].previousPricing.seenCounter, 3);
            assert.equal(second.market.updates[0].pricing.seenCounter, 4);
            if (mode === 'snapshot') assert.equal(second.state.simulation.revision, 1,
                'the rearmed review uses the fresh accepted snapshot');
            send('table_page', { tables: [{ name: 'board', from: 1, to: 2, full: false,
                rows: [[7, boardRow(second.market.updates[0].pricing)]], removed: [] }] });
            send('command_ack', { results: [{ ok: true, characterId: 4242, state: ackState, context,
                ...commandReceipt(second),
                marketDeferred: false, marketCommandId: second.commandId }] });
            send('table_page', { tables: [{ name: 'market', from: 2, to: 3, full: false,
                rows: [['c:material none', counterRow(4)]], removed: [] }] });
            await pause(100);
            assert.equal(commands().length, 2, 'successful fresh checkpoint and replay do not loop');
            send('table_page', { tables: [{ name: 'market', from: 3, to: 4, full: false,
                rows: [['c:material none', counterRow(5)]], removed: [] }] });
            const third = (await until(message => message.type === 'command_request'
                && message.payload.requests[0].commandId !== commandId
                && message.payload.requests[0].commandId !== second.commandId)).payload.requests[0];
            send('command_ack', { results: [{ ok: true, characterId: 4242, state: ackState, context,
                ...commandReceipt(third),
                marketDeferred: true, marketCommandId: third.commandId }] });
            await pause(100);
            assert.equal(commands().length, 3, 'zero-applied ack without a new input does not spin');
            console.log(`Fresh pending evidence survives ${mode} ordering; unchanged deferred input sleeps`);
        } else {
            assert.equal(afterAck, 1, 'a command ack after fence cannot resurrect a removed cold owner before a fresh snapshot');
            const fresh = { ...state, simulation: { ownerId: 'legacy_main', revision: 1,
                leaseId: null, leaseUntil: null } };
            send('snapshot_page', { done: true, rows: [{ state: fresh, context }] });
            const second = (await until(message => message.type === 'command_request' && message !== first)).payload.requests[0];
            assert.notEqual(second.commandId, commandId);
            assert.equal(second.state.simulation.revision, 1);
            assert.equal(second.market.updates[0].pricing.seenCounter, 4);
            send('command_ack', { results: [{ ok: true, characterId: 4242, state, context,
                ...commandReceipt(first.payload.requests[0]),
                marketDeferred: false, marketCommandId: commandId }] });
            send('table_page', { tables: [{ name: 'market', from: 2, to: 3, full: false,
                rows: [['c:material none', counterRow(5)]], removed: [] }] });
            await pause(100);
            assert.equal(commands().length, 2, 'duplicate old ack cannot complete the newer owner command');
            console.log('Fence discards late cold ack; fresh snapshot resumes only its current command');
        }
        assert.equal(received.some(message => message.type === 'claim_request'
            || message.type === 'proposal_batch'), false, 'market ack ordering never manufactures combat');

    } finally { await worker.terminate(); }
}
(async () => {
    await check('deferred');
    await check('fence');
    await check('snapshot');
    await check('pressure');
    console.log('N53 real-worker ack ordering checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
