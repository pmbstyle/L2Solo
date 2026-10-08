'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Calculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
const timestamp = Date.now();
const epoch = 'party-goal-native';
const members = [701, 702].map(characterId => ({ characterId, phase: 'cold', updatedAt: timestamp,
    level: 20, activity: 'resting', adena: 10000, inventory: {},
    spotId: 'execution-ground', stats: { classId: 0 }, timing: { nextResolveAt: timestamp + 3600000 },
    simulation: { ownerId: 'legacy_main', revision: 2, leaseId: null },
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } }));
const party = { partyId: 'goal-worker', memberIds: [701, 702], leaderId: 701,
    stats: { objective: { clanGoalKey: 'clan-native', spotId: 'protected' } } };
const worker = new Worker(path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
    { workerData: { workerEpoch: epoch }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
const messages = []; let fault;
worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
async function wait(predicate) {
    const deadline = Date.now() + 12000;
    while (!messages.some(predicate)) {
        if (fault) throw fault;
        if (Date.now() > deadline) throw Error('party goal native reply timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return messages.find(predicate);
}
function post(type, payload, id) { worker.postMessage(Protocol.envelope(type, epoch, payload, id)); }
(async () => {
    await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
    post('init', { config: { pvpAggression: 0 } }, 'init');
    await wait(message => message.type === 'ready' && message.payload.phase === 'running');
    post('pause', {}, 'pause');
    post('snapshot_page', { rows: members.map(state => ({ state, context: {} })),
        initial: true, done: true, ack: true }, 'snapshot');
    await wait(message => message.msgId === 'snapshot');
    const request = { party, members, escrows: [0, 0], timestamp, replyBy: Date.now() + 5000 };
    post('party_goal_request', request, 'goals');
    const response = await wait(message => message.type === 'party_goal_result' && message.msgId === 'goals');
    assert.equal(response.payload.ok, true, response.payload.reason);
    assert.deepEqual(response.payload.joint.objective, party.stats.objective);
    assert.equal(response.payload.joint.memberGoals.length, 2);
    assert.deepEqual(response.payload.sources, Calculation.sources(members));
    assert(!messages.some(message => message.type === 'fault'), 'native worker loads no forbidden dependency');
    const changed = structuredClone(members); changed[0].updatedAt++; changed[0].stats.partyRequest = { spotId: 'fresh-request' };
    post('party_goal_request', { ...request, members: changed, replyBy: Date.now() + 5000 }, 'changed');
    const fresh = await wait(message => message.type === 'party_goal_result' && message.msgId === 'changed');
    assert.equal(fresh.payload.ok, true, fresh.payload.reason);
    assert.equal(fresh.payload.joint.memberGoals[0].spotId, 'fresh-request', 'complete new input supersedes old mirror');
    assert.deepEqual(fresh.payload.sources, Calculation.sources(changed));
    const page = (pageIndex, id, replyBy = Date.now() + 5000) => post('party_goal_request', {
        ...(pageIndex === 0 ? { party } : { partyId: party.partyId }), members: [members[pageIndex]], escrows: [0],
        timestamp, replyBy, pageIndex, pageCount: 2 }, id);
    const pageDeadline = Date.now() + 5000;
    page(0, 'paged', pageDeadline); page(1, 'paged', pageDeadline);
    const paged = await wait(message => message.type === 'party_goal_result' && message.msgId === 'paged');
    assert.equal(paged.payload.ok, true, paged.payload.reason);
    assert.deepEqual(paged.payload.sources, Calculation.sources(members));
    page(1, 'out-of-order');
    const disordered = await wait(message => message.type === 'party_goal_result' && message.msgId === 'out-of-order');
    assert.equal(disordered.payload.reason, 'party_goal_page_order');
    page(0, 'missing-page', Date.now() + 100);
    const missing = await wait(message => message.type === 'party_goal_result' && message.msgId === 'missing-page');
    assert.equal(missing.payload.reason, 'party_goal_expired');
    page(0, 'duplicate-page', pageDeadline); page(0, 'duplicate-page', pageDeadline);
    const duplicate = await wait(message => message.type === 'party_goal_result' && message.msgId === 'duplicate-page');
    assert.equal(duplicate.payload.ok, false); assert.equal(duplicate.payload.reason, 'party_goal_page_changed');
    const slotDeadline = Date.now() + 200;
    page(0, 'slot-a', slotDeadline); page(0, 'slot-b', slotDeadline); page(0, 'slot-c', slotDeadline);
    const busy = await wait(message => message.type === 'party_goal_result' && message.msgId === 'slot-c');
    assert.equal(busy.payload.reason, 'party_goal_busy', 'partial assemblies share the same admission bound');
    await wait(message => message.type === 'party_goal_result' && message.msgId === 'slot-a');
    await wait(message => message.type === 'party_goal_result' && message.msgId === 'slot-b');
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...members[0], characterId: 710 + i,
        stats: { ...members[0].stats, transportFixture: 'x'.repeat(140000) } }));
    const largeParty = { ...party, leaderId: 710, memberIds: nine.map(member => member.characterId) };
    const largeDeadline = Date.now() + 5000;
    for (let i = 0; i < nine.length; i++) post('party_goal_request', {
        ...(i === 0 ? { party: largeParty } : { partyId: largeParty.partyId }),
        members: [nine[i]], escrows: [0], timestamp, replyBy: largeDeadline, pageIndex: i, pageCount: 9 }, 'nine');
    const largest = await wait(message => message.type === 'party_goal_result' && message.msgId === 'nine');
    assert.equal(largest.payload.ok, true, largest.payload.reason);
    assert.equal(largest.payload.joint.memberGoals.length, 9, 'complete maximum roster survives multiple pages');
    post('party_goal_request', { ...request, replyBy: timestamp }, 'expired');
    const expired = await wait(message => message.type === 'party_goal_result' && message.msgId === 'expired');
    assert.equal(expired.payload.ok, false);
    console.log('PASS native 256MiB worker: complete source replacement, protected goal, expired request; wire bytes',
        Protocol.byteLength(Protocol.envelope('party_goal_request', epoch, request)), Protocol.byteLength(response));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => worker.terminate());
