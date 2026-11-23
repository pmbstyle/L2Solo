'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const state = { characterId: 1, phase: 'hot', activity: 'shopping', updatedAt: 1000, nearSeq: 1,
    timing: { lastResolvedAt: 1000, nextResolveAt: 2000 },
    stats: { playedHours: 174, coldCombat: { capturedAt: 1000, cpAt: 1000, cp: 500 } },
    raise: { seq: 1, names: [{ name: 'goal_failed', seq: 1 }] },
    inventory: { 57: { amount: 1000 } },
    simulation: { revision: 1 } };
const party = { phase: 'hot', revision: 1, hotAt: 0,
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
    kernel.upsert({ state: structuredClone(state) });
    assert.equal(kernel.states.get(1).state, original, 'identical native refresh must keep the active computation source');
    const { raise, ...settled } = structuredClone(state);
    const refreshed = { ...settled, updatedAt: 1100, nearSeq: 2,
        stats: { lastReason: 'near_post', playedHours: 174 + 100 / 3600000,
            coldCombat: { capturedAt: 1100, cpAt: 1100, cp: 500 } } };
    const expectedStats = structuredClone(refreshed.stats);
    kernel.upsert({ state: refreshed });
    assert.equal(kernel.states.get(1).state.nearSeq, 2, 'the newer post remains canonical');
    assert.deepEqual(kernel.states.get(1).state.stats, expectedStats, 'the new clocks stay on the canonical snapshot');
    assert.equal(kernel.commandStartedAt.get(1)?.state, kernel.states.get(1).state,
        'metadata refresh and an acknowledged raise keep and rebase the preparation');
    assert.equal(kernel.upsert({ state: { ...state, inventory: {} } }), false, 'a late older near post is still fenced out');
    finish(request); await new Promise(resolve => setImmediate(resolve));
    assert(messages.some(message => message.type === 'command_request'));
    for (const frame of frames) kernel.completeMeetingPage({ kind: 'meeting', characterId: 1, commandId: request.token, pageIndex: frame[2], ok: true });
    assert(!kernel.commandStartedAt.has(1));
    for (const [label, patch, path] of [
        ['physical stock at the same revision', { inventory: { 57: { amount: 999 } } }, 'inventory.57.amount'],
        ['current CP', { stats: { ...refreshed.stats, coldCombat: { ...refreshed.stats.coldCombat, cp: 499 } } }, 'stats.coldCombat.cp'],
        ['decision state', { stats: { ...refreshed.stats, decisionSeq: 1, coldCombat: { ...refreshed.stats.coldCombat, cp: 499 } } }, 'stats.decisionSeq'],
        ['ownership revision', { simulation: { revision: 2 } }, 'simulation.revision']
    ]) {
        admit();
        const firstMessage = messages.length;
        kernel.upsert({ state: { ...kernel.states.get(1).state, ...patch } });
        assert(!kernel.commandStartedAt.has(1), `changed ${label} must still cancel`);
        finish(request); await new Promise(resolve => setImmediate(resolve));
        const emitted = messages.slice(firstMessage);
        const refusal = emitted.find(message => message.type === 'command_ack')?.payload.results[0];
        assert.equal(refusal?.reason, 'trade_meeting_owner_changed');
        assert.deepEqual(refusal.ownerChange, { paths: [path], postReason: 'near_post' });
        assert(!emitted.some(message => message.type === 'command_request'), 'a cancelled preparation cannot send approval');
    }
    console.log('PASS bookkeeping refresh rebases preparation; old posts are fenced and stock, CP and revision changes cancel');
})().catch(error => { console.error(error); process.exitCode = 1; });
