'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const request = { token: 'merchant-consent', actorA: 1, actorB: 2, seqA: 1, seqB: 1, town: 'Giran',
    point: { locX: 83396, locY: 147904, locZ: -3404 },
    parties: [1, 2].map(() => ({ phase: 'cold', ownerId: 'legacy_main', leaseId: null,
        hotAt: 0, revision: 4, sequence: 1, needRevision: 4,
        route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
    lines: [{ payer: 1, itemId: 123, selfId: 20, enchant: 0, count: 1, price: 4079,
        adId: 456, adRevision: 1, certificate: null }] };
const frames = (input, id = 1) => Codec.commandPages(input, frame => Protocol.envelope('command_request', 'e',
    { requests: [{ kind: 'meeting', characterId: id, commandId: input.token, frame }] }, 'm'));
const row = (id, now) => ({ characterId: id, phase: 'cold', activity: 'resting',
    simulation: { ownerId: 'legacy_main', revision: 4, leaseId: null, leaseUntil: 0 },
    timing: { lastResolvedAt: now - 60000, nextResolveAt: now + 100 },
    stats: { restUntil: now + 100 } });
(async () => {
    for (const outcome of ['accepted', 'refused', 'expired', 'failed']) {
        let now = 1000;
        const emitted = [];
        const kernel = new ColdSimulationKernel({ maxInFlight: 1, now: () => now,
            resolveSolo: () => { throw Error('consent_must_not_resolve_combat'); },
            emit: (type, payload) => { emitted.push({ type, payload }); return true; } });
        kernel.upsert({ state: row(1, now) });
        // Another actor owns the only combat/commit slot. This merchant is free.
        kernel.claiming.add(2);
        kernel.prepareMeeting = async () => { if (outcome === 'failed') throw Error('preparation_failed'); return request; };
        kernel.meetingResultPages = () => [[2, request.token, 0, 2, 'a'], [2, request.token, 1, 2, 'b']];
        for (const frame of frames(request)) assert(kernel.receiveMeetingPage({ kind: 'meeting', characterId: 1,
            commandId: request.token, frame }), 'a full unrelated combat window must not reject consent');
        assert.equal(kernel.commanding.size, 1);
        assert.equal(kernel.receiveMeetingPage({ kind: 'meeting', characterId: 2,
            commandId: request.token, frame: frames(request, 2)[0] }), false, 'the same actor cannot have two owners');
        now += 101;
        kernel.dueCandidates(now, 1); // consumes the overdue heap token while consent holds the owner
        assert.equal(kernel.scheduleTokens.has(1), false);
        await new Promise(resolve => setImmediate(resolve));
        const identity = { kind: 'meeting', characterId: 1, commandId: request.token };
        if (outcome === 'accepted') {
            kernel.completeMeetingPage({ ...identity, pageIndex: 0, ok: true });
            assert(kernel.commanding.has(1), 'prefix ACK must keep the preparation owner');
            kernel.completeMeetingPage({ ...identity, pageIndex: 1, ok: true });
        } else if (outcome !== 'failed') kernel.completeMeetingPage({ ...identity, pageIndex: -1, ok: false });
        assert.equal(kernel.commanding.size, 0, outcome);
        assert(kernel.scheduleTokens.has(1), 'every terminal consent outcome must restore the resting bot');
        kernel.claiming.delete(2);
        const candidates = kernel.dueCandidates(now, 1);
        assert.equal(candidates[0]?.characterId, 1, 'the overdue recovery must be selected again');
        assert.equal(candidates[0]?.purpose.kind, 'resolver');
    }
    const kernel = new ColdSimulationKernel({ maxInFlight: 1, now: () => 1000, emit: () => true,
        resolveSolo: () => { throw Error('consent_must_not_resolve_combat'); } });
    kernel.prepareMeeting = () => new Promise(() => {});
    for (let id = 1; id <= 17; id++) {
        kernel.upsert({ state: row(id, 1000) });
        const input = { ...request, token: 'bounded-consent-' + id, actorA: id, actorB: 100 + id };
        const first = frames(input, id)[0];
        assert.equal(kernel.receiveMeetingPage({ kind: 'meeting', characterId: id, commandId: input.token, frame: first }), id <= 16);
    }
    assert.equal(kernel.commanding.size, 16, 'consent admission remains independently bounded');
    console.log('PASS bounded merchant consent under a full combat window and recovery after ACK, rejection, expiry and failure');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
