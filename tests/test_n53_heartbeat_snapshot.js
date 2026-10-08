process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // Fixture inspects optional developer counters.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
const { ColdSimulationKernel } = require(root + '/src/GameServer/Bot/Population/ColdSimulationKernel');
const at = 1000000;
const state = (id, dueAt = at + 60000) => ({ characterId: id, phase: 'cold', activity: 'hunting',
    inventory: {}, stats: {}, simulation: { revision: 0 }, timing: { nextResolveAt: dueAt } });
const kernel = () => new ColdSimulationKernel({ now: () => at, resolveSolo: () => ({}) });
const image = h => ({ entries: h.heap.values.slice(), tokens: [...h.scheduleTokens], alarms: [...h.alarms],
    states: [...h.states], dirty: [...h.dirty], claiming: [...h.claiming], active: [...h.inFlight],
    commands: [...h.commanding], stats: { ...h.stats }, paused: h.paused, stopping: h.stopping });
const light = h => { assert.equal(typeof h.heartbeatSnapshot, 'function', 'attached light API is required'); return h.heartbeatSnapshot(); };
function noLegacy(payload) {
    for (const key of ['due', 'dueAgeMs', 'dueFences']) assert(!Object.hasOwn(payload, key), `light ${key} is absent`);
}
const failures = [];
async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}
(async () => {
    for (const count of [16, 64]) await check(`light reads zero unrelated facts with ${count} retained rows`, () => {
        const h = kernel(); h.upsert(state(1, at - 100));
        for (let i = 2; i <= count + 1; i++) h.upsert(state(i));
        const detail = h.snapshot();
        assert.equal(detail.due, 1); assert.equal(detail.dueAgeMs, 100); assert.equal(detail.dueFences.scheduled, 1);
        const before = image(h), visits = { iterations: 0, phase: 0, timing: 0 };
        const values = h.states.values.bind(h.states);
        h.states.values = function* () { for (const value of values()) { visits.iterations++; yield value; } };
        for (let i = 2; i <= count + 1; i++) {
            const row = h.states.get(i).state, timing = row.timing;
            Object.defineProperty(row, 'phase', { get() { visits.phase++; return 'cold'; } });
            Object.defineProperty(row, 'timing', { get() { visits.timing++; return timing; } });
        }
        // Before-feature mode deliberately measures the actual old transport
        // snapshot; production must never use this detailed fallback.
        const payload = typeof h.heartbeatSnapshot === 'function' ? light(h) : h.snapshot();
        assert.deepEqual(visits, { iterations: 0, phase: 0, timing: 0 }, 'routine metadata must not traverse unrelated actors');
        assert.deepEqual(payload.queueHead, { kind: 'normal', dueAt: at - 100, overdue: true, ageMs: 100, current: true });
        noLegacy(payload); assert.deepEqual(image(h), before);
    });
    await check('empty and future metadata have exact scalar and age parity without detailed classification', () => {
        const h = kernel();
        const initial = light(h);
        // ARCH-NOTE: M7 removes the worker's autonomous safety alarm.
        assert.deepEqual(initial.queueHead, { kind: 'empty', dueAt: null, overdue: false, ageMs: 0, current: false });
        for (const entry of [...h.alarms.values()]) h.cancelAlarm(entry.alarmKind, entry.key, entry.alarmToken);
        assert.deepEqual(light(h).queueHead, { kind: 'empty', dueAt: null, overdue: false, ageMs: 0, current: false });
        h.upsert(state(1)); h.upsert(state(2, at + 80000));
        h.dirty.set(1, { enqueuedAt: at - 100 }); h.dirty.set(2, { enqueuedAt: at - 300 });
        h.commanding.add(2); h.commandStartedAt.set(2, at - 250);
        const detail = h.snapshot(), before = image(h);
        const expected = { ...detail }; delete expected.due; delete expected.dueAgeMs; delete expected.dueFences;
        expected.queueHead = { kind: 'normal', dueAt: at + 60000, overdue: false, ageMs: 0, current: true };
        h.states.values = () => { throw Error('no retained iterator'); };
        h.states.get(1).state.timing = new Proxy({}, { get() { throw Error('no classification'); } });
        assert.deepEqual(light(h), expected); noLegacy(light(h)); assert.deepEqual(image(h), before);
    });
    await check('stale physical head is reported without popping, seeking or fabricating normal work', () => {
        const h = kernel(); h.upsert(state(1, at - 100));
        const retired = h.heap.peek(); h.requeue(1, at + 500);
        // ARCH-NOTE: M6 removes replaced nodes immediately. Inject a lost
        // unowned node to retain the read-only stale-head contract check.
        assert(!h.heap.values.includes(retired), 'rescheduling releases the old node');
        h.heap.push(retired);
        const before = image(h), original = h.heap.peek;
        let peeks = 0; h.heap.peek = function () { peeks++; return original.call(this); };
        h.heap.pop = () => { throw Error('heartbeat cannot clean stale head'); };
        h.states.values = () => { throw Error('no all-state search'); };
        const payload = light(h);
        assert.deepEqual(payload.queueHead, { kind: 'normal', dueAt: at - 100, overdue: true, ageMs: 100, current: false });
        assert.equal(peeks, 1); assert.deepEqual(image(h), before);
        const old = h.heap.peek(); h.scheduleTokens.set(1, { ...h.scheduleTokens.get(1), token: old.scheduleToken, version: old.version });
        assert.equal(light(h).queueHead.current, false, 'same values with a different physical heapEntry are stale');
        h.scheduleTokens.set(1, { token: old.scheduleToken, version: old.version, heapEntry: old });
        assert.equal(light(h).queueHead.current, true);
        h.states.set(1, { ...h.states.get(1), version: old.version + 1 });
        assert.equal(light(h).queueHead.current, false, 'current retained version is required');
    });
    await check('mixed-heap alarm head preserves kind and exact identity without dispatch', () => {
        const h = kernel(); h.upsert(state(1, at - 50)); h.claiming.add(2);
        const token = h.armAlarm('claim_ack', 2, at - 100, { stamp: 'heartbeat-alarm', characterId: 2, operational: true });
        const before = image(h), entry = h.heap.peek();
        h.drainOperationalAlarms = () => { throw Error('no alarm dispatch'); };
        assert.equal(token, entry.alarmToken);
        assert.deepEqual(light(h).queueHead, { kind: 'alarm', alarmKind: 'claim_ack', dueAt: at - 100, overdue: true, ageMs: 100, current: true });
        assert.deepEqual(image(h), before);
        h.alarms.set(entry.alarmKey, { ...entry });
        assert.equal(light(h).queueHead.current, false, 'an equal-looking replacement alarm is not the peeked entry');
        h.alarms.delete(entry.alarmKey); assert.equal(light(h).queueHead.current, false);
    });
    await check('paused full and busy ownership do not turn physical metadata into runnable population', () => {
        for (const busy of ['claiming', 'inFlight', 'commanding']) {
            const h = kernel(); h.upsert(state(1, at - 100)); h.pause(); h.maxInFlight = 1;
            if (busy === 'inFlight') h.inFlight.set(1, { grant: {} }); else h[busy].add(1);
            const before = image(h), payload = light(h);
            assert.equal(payload[busy], 1); assert(payload.paused);
            assert.deepEqual(payload.queueHead, { kind: 'normal', dueAt: at - 100, overdue: true, ageMs: 100, current: true });
            noLegacy(payload); assert.deepEqual(image(h), before);
        }
    });
    await check('detailed orphan and nonleader meanings remain distinct from the raw physical peek', () => {
        const h = kernel(); h.upsert(state(1, at - 100)); h.upsert(state(2));
        h.heap.remove(h.scheduleTokens.get(1).heapEntry); h.scheduleTokens.delete(1);
        const detail = h.snapshot(); assert.equal(detail.due, 1); assert.equal(detail.dueFences.orphaned, 1);
        assert.deepEqual(light(h).queueHead, { kind: 'normal', dueAt: at + 60000, overdue: false, ageMs: 0, current: true });
        const party = kernel(); party.upsert({ state: { ...state(3, at - 100), partyId: 'nonleader', activity: 'grouped' },
            context: { isPartyLeader: false, party: { partyId: 'nonleader' } } });
        assert.equal(party.snapshot().due, 0);
    });
    await check('shutdown returns light scalars without invoking detailed snapshot or retained facts', async () => {
        const h = kernel(); h.upsert(state(1)); h.pause();
        h.snapshot = () => { throw Error('routine shutdown cannot invoke detailed snapshot'); };
        h.states.values = () => { throw Error('no shutdown retained classification'); };
        const payload = await h.shutdown(); assert(payload.stopping); assert(payload.paused);
        assert.equal(payload.states, 1); noLegacy(payload);
        assert.deepEqual(payload.queueHead, { kind: 'normal', dueAt: at + 60000, overdue: false, ageMs: 0, current: true });
        assert.equal(h.alarms.size, 0);
    });
    if (failures.length) { console.error(`${failures.length} failed groups`); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
