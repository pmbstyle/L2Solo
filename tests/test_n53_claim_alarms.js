process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');
const { ColdSimulationKernel, DueHeap } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

const failures = [];
async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}
function harness(options = {}) {
    let now = 1000000;
    const messages = [];
    let resolved = 0;
    const kernel = new ColdSimulationKernel({ now: () => now, maxBatch: 8, maxInFlight: 1,
        resolveSolo: () => { resolved++; return { patch: {}, events: [], materialize: {}, nextResolveAt: now + 60000 }; },
        emit: (type, payload, msgId) => { messages.push({ type, payload, msgId }); return true; }, ...options });
    const state = (id, extra = {}) => ({ characterId: id, phase: 'cold', activity: 'hunting', stats: {},
        timing: { lastResolvedAt: now, nextResolveAt: now }, updatedAt: now,
        simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 }, ...extra });
    const add = (id, extra = {}, context = {}) => kernel.upsert({ state: state(id, extra), context: { spot: { id: 'spot' }, ...context } });
    const claims = () => messages.filter(message => message.type === 'claim_request');
    const grant = (candidate, leaseId = `claim-${candidate.characterId}`) => ({ ok: true,
        characterId: candidate.characterId, ownerId: 'cold_simulation_owner', revision: candidate.expectedRevision + 1,
        leaseId, leaseUntil: now + 30000, purpose: candidate.purpose });
    return { kernel, messages, add, claims, grant, state, resolved: () => resolved,
        now: () => now, advance: ms => { now += ms; } };
}
function party(h, ids = [21, 22, 23]) {
    const states = ids.map(id => h.state(id, { partyId: 'alarm-party' }));
    const row = { partyId: 'alarm-party', leaderId: ids[0], memberIds: ids, nextResolveAt: h.now() };
    states.forEach((state, index) => h.kernel.upsert({ state, context: { spot: { id: 'party' },
        party: row, partyMembers: states, isPartyLeader: index === 0 } }));
    return row;
}
const claimAlarmCount = kernel => {
    assert.strictEqual([...kernel.alarms.values()].filter(entry => entry.alarmKind === 'worker_safety').length, 0);
    return [...kernel.alarms.values()].filter(entry => entry.alarmKind === 'claim_ack').length;
};

(async () => {
    await check('late old rejection preserves the replacement request and deadline', () => {
        const h = harness(); h.add(1); h.kernel.tick();
        const first = h.claims()[0];
        h.advance(5000); h.kernel.recoverStalled(h.now());
        h.advance(1000); h.kernel.tick();
        const second = h.claims()[1];
        const started = h.kernel.claimStartedAt.get(1);
        h.kernel.onClaimAck({ rejected: [{ characterId: 1, reason: 'old_rejection' }] }, first.msgId);
        assert.strictEqual(h.kernel.claimStartedAt.get(1), started);
        assert.strictEqual(h.kernel.claiming.has(1), true);
        assert.strictEqual(typeof first.msgId, 'string');
        assert.notStrictEqual(first.msgId, second.msgId);
        h.kernel.onClaimAck({ rejected: [{ characterId: 1, reason: 'matching_rejection' }] }, second.msgId);
        assert.strictEqual(h.kernel.claiming.has(1), false);
        assert.strictEqual(claimAlarmCount(h.kernel), 0);
    });

    await check('same heap recovery bypasses an earlier normal head at capacity zero while paused', () => {
        const h = harness(); h.add(2); h.kernel.tick();
        h.add(1, { timing: { nextResolveAt: h.now() - 1 } });
        const normal = h.kernel.scheduleTokens.get(1);
        const head = h.kernel.heap.peek();
        assert.strictEqual(head.characterId, 1);
        assert.strictEqual(h.kernel.maxInFlight - h.kernel.claiming.size, 0);
        h.kernel.pause(); h.advance(5000); h.kernel.tick();
        assert.strictEqual(h.kernel.claiming.has(2), false);
        assert.strictEqual(h.kernel.stats.claimRecoveries, 1);
        assert.deepStrictEqual(h.kernel.scheduleTokens.get(1), normal);
        assert.strictEqual(h.kernel.heap.peek(), head);
        assert.strictEqual(h.claims().length, 1);
        assert.strictEqual(claimAlarmCount(h.kernel), 0);
        assert.strictEqual(h.kernel.scheduleTokens.get(2).dueAt, h.now() + 1000);
    });

    await check('indexed heap removal preserves arbitrary positions and due/id order', () => {
        const heap = new DueHeap();
        const entries = Array.from({ length: 128 }, (_, index) => ({ characterId: index + 1, dueAt: (index * 37) % 29 }));
        entries.forEach(entry => heap.push(entry));
        const removed = new Set(entries.filter((_, index) => index % 3 === 0));
        for (const entry of removed) {
            assert.strictEqual(heap.remove(entry), true);
            assert.strictEqual(heap.remove(entry), false);
        }
        const expected = entries.filter(entry => !removed.has(entry)).sort((a, b) => heap.compare(a, b));
        for (const entry of expected) assert.strictEqual(heap.pop(), entry);
        assert.strictEqual(heap.size, 0);
        assert.strictEqual(heap.pop(), null);
    });

    await check('blocked atomic party head retains its priority while a claim alarm fires', () => {
        const h = harness({ maxInFlight: 2 }); h.add(51); h.kernel.tick();
        party(h);
        const before = h.kernel.scheduleTokens.get(21), head = h.kernel.heap.peek();
        assert.deepStrictEqual(h.kernel.dueCandidates(h.now(), 1), []);
        assert.strictEqual(h.kernel.partyCapacityBlocked, true);
        const blocked = h.kernel.scheduleTokens.get(21);
        assert.strictEqual(blocked.dueAt, before.dueAt);
        const standing = h.kernel.heap.peek();
        assert.strictEqual(standing.characterId, head.characterId);
        h.kernel.pause(); h.advance(5000); h.kernel.tick();
        assert.strictEqual(h.kernel.claiming.has(51), false);
        assert.strictEqual(h.kernel.stats.claimRecoveries, 1);
        assert.strictEqual(h.kernel.scheduleTokens.get(21), blocked);
        assert.strictEqual(h.kernel.heap.peek(), standing);
        assert.strictEqual(claimAlarmCount(h.kernel), 0);
    });

    await check('unchanged arm does not grow the heap and stale cancel preserves replacement', () => {
        const h = harness(); h.add(3); h.kernel.tick();
        const request = h.claims()[0];
        const size = h.kernel.heap.size;
        const options = { stamp: request.msgId, characterId: 3, operational: true };
        const token = h.kernel.armAlarm('claim_ack', 3, h.now() + 5000, options);
        for (let index = 0; index < 100; index++) assert.strictEqual(h.kernel.armAlarm('claim_ack', 3, h.now() + 5000, options), token);
        assert.strictEqual(h.kernel.heap.size, size);
        const replacement = h.kernel.armAlarm('claim_ack', 3, h.now() + 6000, { ...options, stamp: 'new-request' });
        assert.strictEqual(h.kernel.heap.size, size);
        assert.notStrictEqual(replacement, token);
        assert.strictEqual(h.kernel.cancelAlarm('claim_ack', 3, token), false);
        assert.strictEqual(h.kernel.cancelAlarm('claim_ack', 3, replacement), true);
        assert.strictEqual(claimAlarmCount(h.kernel), 0);
    });

    await check('missing request identity refuses and accepted solo ACK replay is inert', async () => {
        const h = harness(); h.add(4); h.kernel.tick();
        const request = h.claims()[0], token = h.grant(request.payload.candidates[0]);
        const started = h.kernel.claimStartedAt.get(4);
        h.kernel.onClaimAck({ grants: [token] });
        assert.strictEqual(h.kernel.claimStartedAt.get(4), started);
        assert.strictEqual(h.kernel.inFlight.has(4), false);
        h.kernel.onClaimAck({ grants: [token] }, request.msgId);
        await h.kernel.resolveChain;
        assert.strictEqual(h.resolved(), 1);
        const active = h.kernel.inFlight.get(4);
        active.grant = { ...active.grant, leaseUntil: token.leaseUntil + 5000 };
        h.kernel.onClaimAck({ grants: [{ ...token }] }, request.msgId);
        h.kernel.onClaimAck({ grants: [{ ...token }] }, 'old-replayed-request');
        await h.kernel.resolveChain;
        assert.strictEqual(h.kernel.inFlight.get(4), active);
        assert.strictEqual(h.resolved(), 1);
        assert.strictEqual(h.messages.some(message => message.type === 'release_request'), false);
    });

    await check('held old grant cannot consume or release a pending replacement', async () => {
        const h = harness(); h.add(5); h.kernel.tick();
        const first = h.claims()[0], oldGrant = h.grant(first.payload.candidates[0], 'native-first-lease');
        h.advance(5000); h.kernel.recoverStalled(h.now()); h.advance(1000); h.kernel.tick();
        const second = h.claims()[1], started = h.kernel.claimStartedAt.get(5);
        h.kernel.onClaimAck({ grants: [oldGrant] }, first.msgId);
        assert.strictEqual(h.kernel.claimStartedAt.get(5), started);
        assert.strictEqual(h.kernel.claiming.has(5), true);
        assert.strictEqual(h.resolved(), 0);
        assert.strictEqual(h.messages.some(message => message.type === 'release_request'), false);
        h.kernel.onClaimAck({ rejected: [{ characterId: 5, reason: 'lease_active' }] }, second.msgId);
        assert.strictEqual(h.kernel.claiming.has(5), false);
        assert.strictEqual(claimAlarmCount(h.kernel), 0);
        assert.strictEqual(h.kernel.inFlight.has(5), false);
        assert.strictEqual(h.messages.some(message => message.type === 'release_request'), false);
        // A real producer can accept a later claim only after expiry/release,
        // with a different UUID and revision, as the native control proves.
        h.advance(oldGrant.leaseUntil - h.now() + 1); h.kernel.tick();
        const third = h.claims()[2], newGrant = { ...h.grant(third.payload.candidates[0], 'native-new-lease'), revision: oldGrant.revision + 1 };
        h.kernel.onClaimAck({ grants: [newGrant] }, third.msgId);
        await h.kernel.resolveChain;
        const active = h.kernel.inFlight.get(5);
        h.kernel.onClaimAck({ grants: [oldGrant] }, first.msgId);
        assert.strictEqual(h.kernel.inFlight.get(5), active);
        assert.strictEqual(h.messages.some(message => message.type === 'release_request'), false);
    });

    await check('partial party aliases and old party pages cannot enter a replacement run', () => {
        const h = harness({ maxInFlight: 4 }); party(h); h.kernel.tick();
        const first = h.claims()[0], member = h.grant(first.payload.candidates[0]);
        h.kernel.onClaimAck({ grants: [member] }, first.msgId);
        const accepted = h.kernel.partyRuns.get('alarm-party').grants.get(21);
        h.kernel.onClaimAck({ grants: [{ ...member }] }, 'duplicate-old-page');
        assert.strictEqual(h.kernel.partyRuns.get('alarm-party').grants.get(21), accepted);
        assert.strictEqual(h.messages.some(message => message.type === 'release_request'), false);
        h.advance(5000); h.kernel.pause(); h.kernel.tick();
        assert.strictEqual(h.kernel.partyRuns.size, 0);
        assert.strictEqual(h.kernel.claiming.size, 0);
        assert.strictEqual(h.kernel.stats.claimRecoveries, 3);
        assert.strictEqual(claimAlarmCount(h.kernel), 0);
        h.advance(1000); h.kernel.resume(); h.kernel.tick();
        const second = h.claims()[1], run = h.kernel.partyRuns.get('alarm-party');
        h.kernel.onClaimAck({ rejected: [{ characterId: 22, reason: 'old_party_page', purpose: member.purpose }],
            grants: [h.grant(first.payload.candidates[2])] }, first.msgId);
        assert.strictEqual(h.kernel.partyRuns.get('alarm-party'), run);
        assert.strictEqual(run.rejected, false);
        assert.strictEqual(run.grants.size, 0);
        assert.strictEqual(h.kernel.claiming.size, 3);
        assert(second.msgId);
    });

    await check('fence and shutdown cancel only their exact pending alarms', async () => {
        const h = harness({ maxInFlight: 2 }); h.add(6); h.add(7); h.kernel.tick();
        const request = h.claims()[0]; h.kernel.fence(6);
        assert.strictEqual(claimAlarmCount(h.kernel), 1);
        h.kernel.onClaimAck({ grants: [h.grant(request.payload.candidates.find(candidate => candidate.characterId === 6))] }, request.msgId);
        assert.strictEqual(h.kernel.states.has(6), false);
        assert.strictEqual(h.kernel.claiming.has(7), true);
        await h.kernel.shutdown(); h.advance(10000); h.kernel.tick();
        assert.strictEqual(h.kernel.alarms.size, 0);
        assert.strictEqual(h.kernel.claiming.size, 0);
        assert.strictEqual(h.claims().length, 1);
        assert.strictEqual(h.messages.some(message => message.type === 'release_request'), false);
    });
    if (failures.length) throw new Error(`claim alarm contracts failed: ${failures.join(', ')}`);
    console.log('N53 attached claim alarms and request correlation: focused contracts passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
