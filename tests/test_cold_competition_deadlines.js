'use strict';
const assert = require('node:assert/strict');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
function make() {
    let time = 1000;
    const messages = [];
    const kernel = new ColdSimulationKernel({ now: () => time, maxInFlight: 1,
        resolveSolo: () => { throw Error('deadline must not resolve gameplay'); },
        emit: (...args) => messages.push(args) });
    return { kernel, messages, at: value => { time = value; } };
}
function state() {
    return { characterId: 1, phase: 'cold', activity: 'resting', level: 1, stats: {},
        vitals: { hp: 100, maxHp: 100 }, inventory: {}, loc: { locX: 0, locY: 0, locZ: 0 },
        timing: { nextResolveAt: 1000, lastResolvedAt: 0 }, simulation: { ownerId: 'legacy_main', revision: 1 } };
}
// Removing arbitrary nodes keeps the derived minimum exact under sifts. This
// validates cancellation order, not a second source or deadline heap.
{
    const { kernel } = make();
    const keys = Array.from({ length: 70 }, () => ({}));
    const fired = [];
    const tokens = keys.map((key, i) => kernel.armDecisionDeadline(key, 1000 + (i * 31) % 70, i, stamp => fired.push(stamp)));
    for (const i of [0, 9, 27, 49, 69]) assert(kernel.cancelDecisionDeadline(keys[i], tokens[i]));
    assert.equal(kernel.cancelDecisionDeadline(keys[0], tokens[0]), false);
    const sorted = keys.map((key, i) => ({ key, i, due: 1000 + (i * 31) % 70 }))
        .filter(x => ![0, 9, 27, 49, 69].includes(x.i)).sort((a, b) => a.due - b.due);
    for (const item of sorted) {
        assert.equal(kernel.heap.peekDecision().key, item.key);
        assert.equal(kernel.drainDecisionDeadlines(2000, { remaining: 1 }), 1);
        assert.equal(fired.at(-1), item.i);
    }
    assert.equal(kernel.heap.peekDecision(), null);
    assert.equal(kernel.decisionAlarms.size, 0);
    assert.equal(kernel.alarms.size, 0, 'the retired periodic worker safety alarm has no kernel owner');
    assert.equal(kernel.heap.size, 0, 'cancelled and fired decision nodes leave no heap residue');
}
console.log('PASS same-heap decision minimum/cancel/sift ordering and separate operational ownership');

for (const normalHeadFirst of [false, true]) {
    const { kernel, messages } = make();
    kernel.upsert(state());
    kernel.claiming.add(999); // Existing full ownership window, no resolver slot.
    const fired = [];
    for (let i = 0; i < 70; i++) kernel.armDecisionDeadline({}, normalHeadFirst ? 1001 : 999, i, stamp => fired.push(stamp));
    const now = 1002;
    kernel.now = () => now;
    kernel.tick();
    assert.equal(fired.length, 64, 'one actual loop turn shares exactly64 decision removals');
    assert.equal(kernel.decisionAlarms.size, 6); assert.equal(messages.length, 0, 'capacity0 does not claim for a deadline');
    const head = kernel.heartbeatSnapshot().queueHead;
    assert.equal(head.current, true); assert.equal(head.overdue, true);
    assert.equal(head.kind, normalHeadFirst ? 'normal' : 'alarm');
    if (!normalHeadFirst) {
        assert.equal(head.alarmKind, 'decision');
        // Positive capacity against the SAME exhausted budget must return and
        // retain that exact due head, never loop or pop it as a normal actor.
        const before = kernel.heap.peek();
        assert.deepEqual(kernel.dueCandidates(now, 1, { remaining: 0 }), []);
        assert.equal(kernel.heap.peek(), before); assert.equal(kernel.decisionAlarms.size, 6);
    }
    kernel.claiming.clear();
    kernel.tick();
    assert.equal(fired.length, 70); assert.equal(kernel.decisionAlarms.size, 0);
    assert.equal(messages.filter(([type]) => type === 'claim_request').length, 1, 'ordinary owner resumes after retained decision remainder');
}
console.log('PASS >64 due keys: capacity0 + normal/decision heads, truthful retained head, next-turn normal claim');

{
    const { kernel, at } = make();
    const key = {}, calls = [];
    const old = kernel.armDecisionDeadline(key, 1100, 'old', stamp => calls.push(stamp));
    const replacement = kernel.armDecisionDeadline(key, 1200, 'new', stamp => calls.push(stamp));
    assert.equal(kernel.cancelDecisionDeadline(key, old), false);
    at(1100); kernel.pause(); kernel.tick(); assert.deepEqual(calls, []);
    at(1200); kernel.tick(); assert.deepEqual(calls, ['new'], 'paused loop queues genuine expiry without gameplay admission');
    assert.equal(kernel.cancelDecisionDeadline(key, replacement), false);
}
console.log('PASS exact replacement token and paused delivery; no new timers or actor resolves');

// A callback may add an immediately due successor during this turn. All nested
// callbacks consume the SAME budget, while a replaced predecessor never fires.
{
    const { kernel } = make();
    kernel.pause();
    const key = {}, calls = [];
    const stale = kernel.armDecisionDeadline(key, 1000, 'stale', () => { throw Error('stale callback fired'); });
    const fire = stamp => {
        calls.push(stamp);
        if (stamp < 100) kernel.armDecisionDeadline(key, 1000, stamp + 1, fire);
    };
    kernel.armDecisionDeadline(key, 1000, 1, fire);
    assert.equal(kernel.cancelDecisionDeadline(key, stale), false);
    kernel.tick();
    assert.equal(calls.length, 64); assert.equal(calls.at(-1), 64);
    assert.equal(kernel.decisionAlarms.size, 1);
    const head = kernel.heartbeatSnapshot().queueHead;
    assert.equal(head.alarmKind, 'decision'); assert.equal(head.current, true); assert.equal(head.overdue, true);
    kernel.tick();
    assert.equal(calls.length, 100); assert.equal(calls.at(-1), 100); assert.equal(kernel.decisionAlarms.size, 0);
}
console.log('PASS stale replacement + nested immediate callbacks share actual64 turn budget');
