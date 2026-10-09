'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const state = { characterId: 1, phase: 'cold', activity: 'shopping', updatedAt: 1000,
    timing: { lastResolvedAt: 1000, nextResolveAt: 2000 }, stats: {}, inventory: { 57: { amount: 1000 } },
    simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 } };
const party = { phase: 'cold', ownerId: 'legacy_main', revision: 1, leaseId: null, hotAt: 0,
    sequence: 1, needRevision: 1, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } };
const request = { token: 'refresh-test', actorA: 1, actorB: 2, seqA: 1, seqB: 1, town: 'Giran',
    point: { locX: 1, locY: 2, locZ: 3 }, parties: [party, { ...party }],
    lines: [{ payer: 0, itemId: 3, selfId: 1867, count: 1, price: 10 }] };
const messages = [], kernel = new ColdSimulationKernel({ resolveSolo: () => { throw Error('unexpected combat'); }, now: () => 1000, emit: (type, payload) => { messages.push({ type, payload }); return true; } });
let finish;
kernel.prepareMeeting = () => new Promise(resolve => { finish = resolve; });
kernel.meetingResultPages = result => Codec.pages(result);
const frames = Codec.pages(request);
const admit = () => { for (const frame of frames) assert(kernel.receiveMeetingPage({ kind: 'meeting', characterId: 1, commandId: request.token, frame })); };
(async () => {
    kernel.upsert({ state }); admit();
    const original = kernel.states.get(1).state;
    kernel.upsert({ state: structuredClone(state), context: { catalogRefreshed: true } });
    assert.equal(kernel.states.get(1).state, original, 'identical native refresh must keep the active computation source');
    assert(kernel.commandStartedAt.has(1), 'refresh must not cancel bilateral preparation');
    finish(request); await new Promise(resolve => setImmediate(resolve));
    assert(messages.some(message => message.type === 'command_request'));
    for (const frame of frames) kernel.completeMeetingPage({ kind: 'meeting', characterId: 1, commandId: request.token, pageIndex: frame[2], ok: true });
    assert(!kernel.commandStartedAt.has(1));
    admit();
    kernel.upsert({ state: { ...structuredClone(state), inventory: { 57: { amount: 999 } } } });
    assert(!kernel.commandStartedAt.has(1), 'changed physical bag at same revision must still cancel');
    assert(messages.some(message => message.type === 'command_ack' && message.payload.results[0].reason === 'trade_meeting_owner_changed'));
    finish(request); await new Promise(resolve => setImmediate(resolve));
    console.log('PASS equal source refresh preserves preparation; changed bag cancels without stale approval');
})().catch(error => { console.error(error); process.exitCode = 1; });
