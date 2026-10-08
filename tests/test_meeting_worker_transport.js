'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const source = path.resolve(__dirname, '../src');
const state = { characterId: 1, phase: 'hot', activity: 'shopping', updatedAt: 1,
    simulation: { ownerId: 'legacy_main', revision: 4, leaseId: null, leaseUntil: 0 },
    timing: { activityStartedAt: 1, lastResolvedAt: 1, nextResolveAt: 9999999999999, lastHotAt: 7 }, stats: {}, inventory: {} };
const request = { token: 'transport-original-token', actorA: 1, actorB: 2, seqA: 2, seqB: 3, town: 'Giran',
    point: { locX: 1, locY: 2, locZ: 3 }, parties: [0,1].map((_, side) => ({ phase: side ? 'cold' : 'hot',
        ownerId: 'legacy_main', leaseId: null, hotAt: side ? 0 : 7, revision: 4, sequence: side ? 3 : 2, needRevision: 4,
        route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
    lines: [{ payer: 0, itemId: 3, selfId: 1867, enchant: 0, count: 2, price: 3, adId: 1, adRevision: 2,
        certificate: [1867,2,3,1,100,1,0,1,1] }] };
let pages = 0, bytes = 0;
const originalCached = Life.cachedState, originalAdjust = Service.adjustTransportPages;
Life.cachedState = () => state;
Service.adjustTransportPages = (delta, deltaBytes) => {
    assert(pages + delta <= 64 && bytes + deltaBytes <= 48 * 1024);
    pages += delta; bytes += deltaBytes;
};
const coordinator = new ColdSimulationCoordinator();
coordinator.ready = true; coordinator.workerEpoch = 'meeting-test-epoch';
coordinator.contextFor = () => ({}); coordinator.contextIndex = () => ({});
const worker = new Worker(`
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.source + '/Global');
const { ColdSimulationKernel } = require(workerData.source + '/GameServer/Bot/Population/ColdSimulationKernel');
const Protocol = require(workerData.source + '/GameServer/Bot/Population/ColdSimulationProtocol');
const Codec = require(workerData.source + '/GameServer/AfkTrade/TradeMeetingCodec');
const kernel = new ColdSimulationKernel({ resolveSolo() { throw Error('meeting_must_not_resolve_combat'); }, emit(type, payload, msgId) {
  const message = Protocol.envelope(type, workerData.epoch, payload, msgId);
  if (!Protocol.validateEnvelope(message, 'worker').ok) throw Error('invalid_worker_envelope');
  parentPort.postMessage(message); return true;
} });
kernel.prepareMeeting = async (id, input) => input;
kernel.meetingResultPages = (input,id,token) => Codec.commandPages(input, frame =>
  Protocol.envelope('command_request',workerData.epoch,{requests:[{kind:'meeting',characterId:id,commandId:token,frame}]}, 'meeting-result:'+id+':'+token+':3'), []);
parentPort.on('message', message => {
  if (!Protocol.validateEnvelope(message,'main',{workerEpoch:workerData.epoch}).ok) throw Error('invalid_main_envelope');
  if (message.type === 'snapshot_page') for (const row of message.payload.rows) kernel.upsert(row);
  if (message.type === 'command_request') for (const request of message.payload.requests) {
    if (!kernel.receiveMeetingPage(request)) throw Error('owner_not_admitted');
  }
  if (message.type === 'command_ack') for (const result of message.payload.results) kernel.completeCommand(result);
});
`, { eval: true, workerData: { source, epoch: coordinator.workerEpoch } });
coordinator.worker = worker;
let received = 0, sent = 0, refreshes = 0;
const nativePost = worker.postMessage.bind(worker);
worker.postMessage = message => { if (message.type === 'snapshot_page' && message.payload.reconcile) refreshes++; if (message.type === 'command_request') { assert(Buffer.byteLength(JSON.stringify(message)) <= 768); sent++; } nativePost(message); };
worker.on('message', message => { if (message.type === 'command_request') { assert(Buffer.byteLength(JSON.stringify(message)) <= 768); received++; }
    coordinator.onMessage(message, worker, coordinator.workerEpoch).catch(error => { throw error; }); });
(async () => {
    try {
        // The lifecycle tail must finish first: this is the actual deadlock path.
        let release; coordinator.commandTail = new Promise(resolve => { release = resolve; });
        const pending = coordinator.requestMeetingPreparation(1, request);
        await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 0);
        release();
        const timeout = setTimeout(() => { throw Error('transport_timeout'); }, 10000);
        const proof = await pending; clearTimeout(timeout);
        assert.equal(proof.approved, true); assert.equal(proof.token, request.token);
        assert.equal(proof.authority.phase, 'hot'); assert.equal(proof.sequence, 2);
        assert.deepEqual(proof.certificates, [request.lines[0].certificate]);
        assert(sent > 0 && received > 0); assert.equal(pages, 0); assert.equal(bytes, 0);
        assert.equal(coordinator.commandInflight.size, 0);
        // Same frame is valid under both directions; a prefix is not a basket.
        const full = Codec.commandPages(request, frame => Protocol.envelope('command_request', 'e',
            { requests: [{ kind: 'meeting', characterId: 1, commandId: request.token, frame }] }, 'm'));
        const changed = [...full[0]]; changed[4] += 'changed';
        assert.throws(() => Codec.fromPages([...full, changed]), /consent_changed/);
        let releaseRefresh; coordinator.commandTail = new Promise(resolve => { releaseRefresh = resolve; });
        const owned = Promise.resolve(); coordinator.commandInflight.set(1, owned);
        assert(coordinator.requestEconomyRefresh(1)); assert(coordinator.requestEconomyRefresh(1));
        await new Promise(resolve => setImmediate(resolve)); assert.equal(refreshes, 0);
        assert.equal(owned.economyRefreshPending, true);
        coordinator.commandInflight.delete(1); releaseRefresh();
        await new Promise(resolve => setImmediate(resolve)); assert.equal(refreshes, 1, 'post-action BUY refresh coalesces behind lifecycle ACK');
        console.log('PASS real worker MessagePort meeting pages, hot owner, original token, deferred lifecycle tail, global reservation release and one coalesced post-action BUY refresh');
    } finally {
        await worker.terminate(); Life.cachedState = originalCached; Service.adjustTransportPages = originalAdjust;
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
