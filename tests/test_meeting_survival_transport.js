'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const request = { token: 'survival-transport', actorA: 701, actorB: 702, seqA: 1, seqB: 1,
    town: 'Giran', point: { locX: 83396, locY: 147904, locZ: -3400 },
    parties: [0, 1].map(() => ({ phase: 'cold', hotAt: 0, revision: 1, sequence: 1, needRevision: 1,
        route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
    lines: [{ payer: 0, itemId: 1001, selfId: 1463, count: 4, price: 100, enchant: 0,
        adId: 10, adRevision: 1, certificate: [1463, 4, 100, 2, 1, 0, 0, 2, .01] }] };
const prepared = structuredClone(request);
prepared.parties[0].survivalCost = 400;
const frames = Codec.commandPages(prepared, frame => frame, []);
const worker = {}, epoch = 'survival-proof';
const held = { meetingToken: request.token, epoch, worker, frames: [],
    termsDigest: Coordinator.meetingTermsDigest(request) };
let received;
const host = { commandInflight: new Map([[701, held]]), meetingTermsDigest: Coordinator.meetingTermsDigest,
    finishMeetingPreparation: (_id, _held, proof, error) => { if (error) throw error; received = proof; },
    post: () => true };
for (const frame of frames) Coordinator.handleMeetingRequest.call(host, { msgId: 'survival', payload: { requests: [{
    kind: 'meeting', characterId: 701, commandId: request.token, frame }] } }, worker, epoch);
assert.equal(received?.survivalCost, 400, 'the coordinator retains the worker-approved survival tranche');
console.log('PASS meeting survival funding survives worker transport and coordinator proof');
